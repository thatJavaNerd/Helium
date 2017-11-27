import * as _ from 'lodash';
import * as moment from 'moment';

import {
    Constraint, ConstraintType, DefaultValue, SqlRow, TableDataType,
    TableHeader, TableMeta
} from '../../common/api';
import {
    BLOB_STRING_REPRESENTATION, CURRENT_TIMESTAMP, DATE_FORMAT,
    DATETIME_FORMAT
} from '../../common/constants';
import { TableName } from '../../common/table-name.class';
import { unflattenTableNames } from '../../common/util';
import { Database } from '../../db/database.helper';
import { TableInputValidator } from './table-input.validator';

/**
 * Simple interface for describing the way some data is to be organized
 */
export interface Sort {
    direction: 'asc' | 'desc';
    /** Name of the column to sort by */
    by: string;
}

export class TableDao {
    private validator: TableInputValidator;

    public constructor(private helper: Database) {
        this.validator = new TableInputValidator(this);
    }

    public async schemas(): Promise<string[]> {
        return (await this.helper.executeRaw('SHOW SCHEMAS;'))
            .map((row: SqlRow) => row[Object.keys(row)[0]]);
    }

    /**
     * Returns an array of all available table names
     */
    public async tables(db: string): Promise<TableName[]> {
        // db.conn is a PromiseConnection that wraps a Connection. A
        // Connection has a property `config`
        const result = await this.helper.executeRaw('SHOW TABLES FROM ' + this.helper.escapeId(db));
        return _.map(result, (row: SqlRow): TableName => new TableName(row[Object.keys(row)[0]]));
    }

    /**
     * Fetches the data from the table
     *
     * @param {string} schema Database name
     * @param {string} table Table name
     * @param {number} page Which page to request. Pages are 1-indexed, so 0 is
     * an invalid page, 1 is the first page, 2 is the second, and so on. A "page"
     * is pretty arbitrary since what data is included depends heavily on
     * `limit`.
     *
     * @param {number} limit How many rows to fetch in one go
     * @param {Sort} sort If provided, will attempt to sort the results by this
     * column/direction
     * @returns {Promise<SqlRow[]>} A promise that resolves to the requested data
     */
    public async content(schema: string,
                         table: string,
                         page: number = 1,
                         limit: number = 25,
                         sort?: Sort | undefined): Promise<SqlRow[]> {

        const rows = await this.helper.execute((squel) => {
            // Create our basic query
            let query = squel
                .select()
                // Make sure we escape the table name so that we're less vulnerable to
                // SQL injection
                .from(this.helper.escapeId(schema) + '.' + this.helper.escapeId(table))
                // Pagination
                .limit(limit)
                .offset((page - 1) * limit);

            if (sort !== undefined) {
                // Specify a sort if provided
                query = query.order(this.helper.escapeId(sort.by), sort.direction === 'asc');
            }

            return query;
        });

        // We need access to the table's headers to resolve Dates and blobs to
        // the right string representation
        const headers: TableHeader[] = await this.headers(schema, table);
        const blobHeaders = _(headers)
            .filter((h) => h.type === 'blob')
            .map((h) => h.name)
            .value();

        for (const row of rows) {
            for (const col of Object.keys(row)) {
                if (row[col] instanceof Date) {
                    const header = _.find(headers, (h) => h.name === col);
                    if (header === undefined)
                        throw Error(`Could not find header with name ${col}`);

                    if (header.type === 'date')
                        row[col] = moment(row[col]).format(DATE_FORMAT);
                    else if (header.type === 'datetime')
                        row[col] = moment(row[col]).format(DATETIME_FORMAT);
                    else
                        throw Error(`Header ${header.name} unexpectedly had a Date value in it`);
                } else if (blobHeaders.indexOf(col) >= 0) {
                    // Don't send the actual binary data, send a specific string
                    // instead
                    row[col] = BLOB_STRING_REPRESENTATION;
                }
            }
        }

        return rows;
    }

    /**
     * Fetches a TableMeta instance for the given table.
     */
    public async meta(schema: string, table: string): Promise<TableMeta> {
        const [allTables, headers, count, constraints, comment] = await Promise.all([
            this.tables(schema),
            this.headers(schema, table),
            this.count(schema, table),
            // For some reason `this` becomes undefined in the resolveConstraints
            // function if we do this.constraints(name).then(this.resolveConstraints)
            this.constraints(schema, table).then((result) => this.resolveConstraints(schema, result)),
            this.comment(schema, table)
        ]);

        // Identify part tables for the given table name
        const masterTables = unflattenTableNames(allTables);
        const masterTable = masterTables.find((t) => t.rawName === table);
        const parts = masterTable ? masterTable.parts : [];

        return {
            name: table,
            headers,
            totalRows: count,
            constraints,
            comment,
            parts
        };
    }

    /**
     * Fetches all distinct values from one column. Useful for autocomplete.
     */
    public async columnContent(schema: string, table: string, column: string):
        Promise<Array<string | number>> {

        // SELECT DISTINCT $col FROM $table ORDER BY $col ASC
        const result = await this.helper.execute((squel) =>
            squel
                .select()
                .distinct()
                .from(this.helper.escapeId(schema) + '.' + this.helper.escapeId(table))
                .field(this.helper.escapeId(column))
                .order(this.helper.escapeId(column))
        );

        // Each row is a document mapping the column to its value. In this case, we
        // only have one item in the row, flatten the array of objects into an array
        // of each value
        return _.map(result, (row) => row[column]);
    }

    /**
     * Inserts a row into a given table. The given data will be verified before
     * inserting.
     */
    public async insertRow(schema: string, table: string, data: any) {
        // Make sure that the given data adheres to the headers
        const preparedData = await this.validator.validate(schema, data);

        return this.helper.transaction(async () => {
            // Make sure we alphabetize the names so we insert master tables first
            const names = _.sortBy(Object.keys(preparedData));

            // Do inserts in sequence so we can guarantee that master tables
            // are inserted before any part tables
            for (const name of names) {
                // Prepare each row for insertion. Escape column names, transform
                // values as appropriate, etc.
                const rows = preparedData[name].map(this.prepareForInsert, this);

                await this.helper.execute((squel) => {
                    return squel.insert()
                        .into(this.helper.escapeId(schema) + '.' + this.helper.escapeId(table))
                        .setFieldsRows(rows);
                });
            }
        });
    }

    /**
     * Returns a Promise the resolves to an array of TableHeaders. Note that
     * `name` is used in a 'LIKE' expression and therefore can contain
     * metacharacters like '%'.
     */
    public async headers(schema: string, name: string): Promise<TableHeader[]> {
        const fields = [
            'COLUMN_NAME', 'ORDINAL_POSITION', 'IS_NULLABLE', 'DATA_TYPE',
            'CHARACTER_MAXIMUM_LENGTH', 'NUMERIC_SCALE', 'NUMERIC_PRECISION',
            'CHARACTER_SET_NAME', 'COLUMN_TYPE', 'COLUMN_COMMENT', 'TABLE_NAME',
            'COLUMN_DEFAULT'
        ];

        const result = await this.helper.execute((squel) => {
            let query = squel.select().from('INFORMATION_SCHEMA.columns');

            for (const field of fields) {
                query = query.field(field);
            }

            return query
                .where('TABLE_SCHEMA = ?', schema)
                .where('TABLE_NAME LIKE ?', name)
                .order('ORDINAL_POSITION');
        });

        // Map each BinaryRow into a TableHeader, removing any additional rows
        // that share the same name
        return _.map(result, (row: any): TableHeader => {
            const rawType = row.COLUMN_TYPE as string;
            const type = TableDao.parseType(rawType);
            const isNumerical = type === 'integer' || type === 'float';
            const defaultValue = TableDao.identifyDefaultValue(rawType, type, row.COLUMN_DEFAULT);

            return {
                name: row.COLUMN_NAME as string,
                type,
                isNumerical,
                isTextual: !isNumerical,
                signed: isNumerical && !rawType.includes('unsigned'),
                ordinalPosition: row.ORDINAL_POSITION as number,
                rawType,
                defaultValue,
                nullable: row.IS_NULLABLE === 'YES',
                maxCharacters: row.CHARACTER_MAXIMUM_LENGTH as number,
                charset: row.CHARACTER_SET_NAME as string,
                numericPrecision: row.NUMERIC_PRECISION as number,
                numericScale: row.NUMERIC_SCALE as number,
                enumValues: TableDao.findEnumValues(row.COLUMN_TYPE as string),
                comment: row.COLUMN_COMMENT as string,
                tableName: row.TABLE_NAME as string
            };
        });
    }

    /**
     * Returns a new SqlRow whose keys are escaped as if they were reserved
     * keywords and whose values have been transformed by {@link #prepareValue}
     */
    private prepareForInsert(validated: SqlRow): SqlRow {
        const result: SqlRow = {};
        for (const columnName of Object.keys(validated)) {
            // Escape the name of the column in case that name is a reserved
            // MySQL keyword like "integer."
            result[this.helper.escapeId(columnName)] = TableDao.prepareValue(validated[columnName]);
        }

        return result;
    }

    /**
     * Gets a list of constraints on a given table. Currently, only primary keys,
     * foreign keys, and unique constraints are recognized.
     */
    private async constraints(schema: string, table: string): Promise<Constraint[]> {
        const result = await this.helper.execute((squel) => {
            return squel.select()
                .from('INFORMATION_SCHEMA.KEY_COLUMN_USAGE')
                    .field('COLUMN_NAME')
                    .field('CONSTRAINT_NAME')
                    .field('REFERENCED_TABLE_NAME')
                    .field('REFERENCED_COLUMN_NAME')
                .where('CONSTRAINT_SCHEMA = ?', schema)
                .where('TABLE_NAME = ?', table)
                .order('ORDINAL_POSITION');
        });

        return _.map(result, (row: any): Constraint => {
            let type: ConstraintType = 'foreign';

            if (row.CONSTRAINT_NAME === 'PRIMARY')
                type = 'primary';
            else if (row.CONSTRAINT_NAME === row.COLUMN_NAME)
                type = 'unique';

            return {
                type,
                localColumn: row.COLUMN_NAME as string,
                foreignTable: row.REFERENCED_TABLE_NAME as string,
                foreignColumn: row.REFERENCED_COLUMN_NAME as string
            };
        });
    }

    /**
     * Attempts to resolve foreign key constraints to their origins. For example,
     * if tableA.foo references tableB.bar and tableB.bar references tableC.baz,
     * the returned array will include a Constraint that maps tableA.foo to
     * tableC.baz instead of tableB.bar.
     *
     * Note that if there are no foreign key constraints
     */
    private async resolveConstraints(schema: string, originals: Constraint[]): Promise<Constraint[]> {
        // Keep tables in cache once we look them up to prevent any unnecessary
        // lookups
        const cache: { [tableName: string]: Constraint[] } = {};

        // Return constraints from cache, otherwise look them up
        const getConstraints = (table: string): Promise<Constraint[]> => {
            return cache[table] ? Promise.resolve(cache[table]) : this.constraints(schema, table);
        };

        const resolved: Constraint[] = [];

        for (const c of originals) {
            // We're only operating on foreign keys here
            if (c.type !== 'foreign') {
                resolved.push(c);
                continue;
            }

            const findConstraint = (localColumn: string, others: Constraint[]): Constraint => {
                const temp = _.find(others, (other: Constraint) => other.localColumn === localColumn);
                if (temp === undefined)
                    throw new Error(`could not find constraint with name '${localColumn}'`);
                return temp;
            };

            let current: Constraint = c;
            let previous: Constraint | undefined;

            // Navigate up the hierarchy until we find a PK constraint.
            while (current.type !== 'primary') {
                previous = current;
                current = findConstraint(current.foreignColumn!!, await getConstraints(current.foreignTable!!));
            }

            if (previous !== undefined)
                resolved.push(previous);
        }

        return resolved;
    }

    /** Fetches a table's comment, or an empty string if none exists */
    private async comment(schema: string, table: string): Promise<string> {
        const result = await this.helper.execute((squel) =>
            squel.select()
                .from('INFORMATION_SCHEMA.TABLES')
                .field('TABLE_COMMENT')
                .where('TABLE_NAME = ?', table)
                .where('TABLE_SCHEMA = ?', schema)
        );

        return result[0].TABLE_COMMENT;
    }

    /** Counts the amount of rows in a table */
    private async count(schema: string, table: string): Promise<number> {
        const result = await this.helper.execute((squel) =>
            squel.select()
                .from(this.helper.escapeId(schema) + '.' + this.helper.escapeId(table))
                .field('COUNT(*)')
        );
        // This query returns only one row
        return result[0]['COUNT(*)'];
    }

    /**
     * Transform simple JS types into their real MySQL values. Right now, all
     * this does is turn the boolean `true` into the number `1` and the boolean
     * `false` into the number `0`. All other values are returned unmodified.
     */
    private static prepareValue(v: any): any {
        if (typeof v === 'boolean')
            return v ? 1 : 0;
        return v;
    }

    private static identifyDefaultValue(rawType: string, type: TableDataType, rawDefault: string): DefaultValue {
        if (rawDefault === CURRENT_TIMESTAMP && rawType === 'datetime')
            return { constantName: CURRENT_TIMESTAMP };

        switch (type) {
            case 'integer':
                return parseInt(rawDefault, 10);
            case 'float':
                return parseFloat(rawDefault);
            case 'boolean':
                return !!parseInt(rawDefault, 10);
            // We don't have to do anything for textual columns
            case 'string':
            case 'enum':
            case 'date':
            case 'datetime':
                return rawDefault;
            case 'blob':
                // Don't leak any blob data
                return null;
        }

        throw new Error(`Could not determine default header for type=${type}`);
    }

    private static parseType(rawType: string): TableDataType {
        if (rawType.includes('tinyint(1)')) return 'boolean';
        if (rawType.includes('int')) return 'integer';
        if (rawType.includes('double') || rawType.includes('float') || rawType.includes('decimal')) return 'float';
        if (rawType === 'date') return 'date';
        if (rawType === 'datetime' || rawType === 'timestamp') return 'datetime';
        if (rawType.startsWith('enum')) return 'enum';
        if (rawType.includes('char')) return 'string';
        if (rawType.includes('blob')) return 'blob';

        throw Error(`Could not determine TableDataType for raw type '${rawType}'`);
    }

    private static findEnumValues(raw: string): string[] | null {
        if (!/^enum\(/.test(raw)) return null;
        const matches = raw.match(/^enum\('(.*)'\)$/);
        if (matches === null || matches.length !== 2)
            throw new Error(`Expecting a match from input string ${raw}`);
        return matches[1].split('\',\'');
    }
}
