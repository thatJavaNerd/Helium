import { HttpErrorResponse } from '@angular/common/http';
import {
    AfterViewInit, Component, OnDestroy, OnInit, ViewChild
} from '@angular/core';
import { AbstractControl, FormControl, FormGroup } from '@angular/forms';
import { MatIconRegistry, MatSidenav, MatSnackBar } from '@angular/material';
import { DomSanitizer } from '@angular/platform-browser';
import { Router } from '@angular/router';
import * as _ from 'lodash';
import { combineLatest, fromEvent, NEVER, Observable, of, Subscription } from 'rxjs';
import { catchError, delay, filter, first, map, startWith, switchMap, tap } from 'rxjs/operators';
import { environment } from '../environments/environment';
import { MasterTableName, SessionPing, TableTier } from './common/api';
import { unflattenTableNames } from './common/util';
import { ApiService } from './core/api/api.service';
import { AuthService } from './core/auth/auth.service';
import { LoginComponent } from './login/login.component';

interface GroupedName { tier: TableTier; names: MasterTableName[]; }

interface SchemaInfo { availableSchemas: string[]; selectedSchema: string; }

@Component({
    selector: 'app',
    templateUrl: 'app.component.html',
    styleUrls: ['app.component.scss']
})
export class AppComponent implements AfterViewInit, OnDestroy, OnInit {
    public static readonly TIER_ORDER: TableTier[] =
        ['manual', 'lookup', 'imported', 'computed', 'hidden', 'unknown'];

    /**
     * If the width of the browser (in pixels) is above this value, the sidenav
     * will always be shown.
     */
    public static readonly ALWAYS_SHOW_SIDENAV_WIDTH = 1480;

    public groupedNames: GroupedName[];

    public schemas: string[] = [];

    private adjustSidenavSub: Subscription;
    public formGroup: FormGroup;
    public schemaControl: AbstractControl;

    private windowWidth$: Observable<number>;

    @ViewChild(MatSidenav)
    private sidenav: MatSidenav;

    public sidenavMode: 'push' | 'over' | 'side' = 'side';

    public constructor(
        public auth: AuthService,
        private backend: ApiService,
        private router: Router,
        private iconReg: MatIconRegistry,
        private domSanitizer: DomSanitizer,
        private snackBar: MatSnackBar
    ) {}

    public ngOnInit() {
        // Fetch available schemas when the user logs in
        const schemas$: Observable<string[] | null> = this.auth.watchAuthState().pipe(
            switchMap((isLoggedIn) => {
                if (isLoggedIn) {
                    return this.backend.schemas().pipe(
                        catchError((err) => {
                            if (err instanceof HttpErrorResponse && err.status === 401) {
                                this.logout('Your session has expired');
                                return of(null);
                            }

                            throw err;
                        })
                    );
                } else {
                    return of(null);
                }
            })
        );
        
        const iconNames: string[] = [
            'filter',
            'key-change',
            'key',
            'snowflake'
        ];

        for (const svgIcon of iconNames) {
            const safeUrl = this.domSanitizer.bypassSecurityTrustResourceUrl(
                `${environment.baseUrl}assets/${svgIcon}.svg`);
                
            this.iconReg.addSvgIconInNamespace('app', svgIcon, safeUrl);
        }

        // Use a form group and <form> element so we can more easily update and
        // read the selected schema
        this.formGroup = new FormGroup({
            schemaSelect: new FormControl()
        });

        this.schemaControl = this.formGroup.get('schemaSelect')!!;
        const selectedSchema$ = this.schemaControl.valueChanges;

        const schemaInfo$: Observable<SchemaInfo | null> = combineLatest(
            schemas$,
            selectedSchema$
        ).pipe(
            filter((data: [string[] | null, string | null]) => {
                // data[0] is an array of available schemas, data[1] is the
                // currently selected schema. Only emit data when both are non-null
                // or both are null. The only time one of these is null is when the
                // user logs out, and is immediately followed by more data coming
                // through the observable
                return (data[0] !== null) === (data[1] !== null);
            }),
            map((data: [string[] | null, string | null]): SchemaInfo | null => {
                // Break the nested array structure up into an object. When both
                // elements are null, simply return null.
                if (data[0] === null || data[1] === null)
                    return null;
                return { availableSchemas: data[0]!!, selectedSchema: data[1]!! };
            })
        );

        schemaInfo$.pipe(
            switchMap((info: SchemaInfo | null) => {
                if (info === null)
                    return of([]);
                else
                    return this.backend.tables(info.selectedSchema);
            }),
            map(unflattenTableNames),
            // Start with an empty array so the template has something to do
            // before we get actual data
            startWith([]),
            map((names: MasterTableName[]) => {
                return _(names)
                    .groupBy((n) => n.tier)
                    .map((value: MasterTableName[], key: TableTier): GroupedName => ({
                        tier: key,
                        names: value
                    }))
                    .sortBy((gn: GroupedName) => {
                        const position = AppComponent.TIER_ORDER.indexOf(gn.tier);
                        if (position < 0)
                            throw new Error('unexpected tier: ' + gn.tier);
                        return position;
                    })
                    .value();
            })
        ).subscribe((names) => { this.groupedNames = names; });

        // Listen for the user logging in and automatically select a schema for
        // them
        schemas$.subscribe((schemas: string[] | null) => {
            if (schemas !== null && this.schemaControl.value === null)
                this.schemaControl.setValue(this.determineDefaultSchema(schemas));
            this.schemas = schemas === null ? [] : schemas;
        });

        this.windowWidth$ = fromEvent(window, 'resize')
            // Start with a value so adjustSidenav gets called on init
            .pipe(
                map(() => window.innerWidth),
                startWith(window.innerWidth)
            );

        // When the window is resized or the user logs in or out, adjust the
        // sidenav.
        this.adjustSidenavSub = combineLatest(this.windowWidth$, this.auth.watchAuthState())
            .subscribe((data) => { this.adjustSidenav(data[0]); });

        // The session has expired
        this.auth.expirationTimer().pipe(
            switchMap(() => {
                // Ping the API to make absolutely sure
                return this.auth.ping().pipe(
                    map((ping: SessionPing) =>
                        // Consider a token invalid if it's gonna expire in the
                        // next second
                        ping.validApiKey && ping.expiresAt && Date.now() < ping.expiresAt - 1000
                    )
                );
            })
        ).subscribe((valid: boolean) => {
            if (!valid) {
                // Expired, log out and redirect
                this.logout('Your session has expired');
            }
        });
    }

    public ngAfterViewInit() {
        // Open the sidenav automatically on smaller devices
        this.windowWidth$.pipe(
            first(),
            // Delay 1ms to open on next change detection cycle
            delay(1)
        ).subscribe((width) => {
            if (width <= AppComponent.ALWAYS_SHOW_SIDENAV_WIDTH && this.router.url === '/tables') {
                this.sidenav.open('program');
            }
        });
    }

    public ngOnDestroy() {
        this.adjustSidenavSub.unsubscribe();
    }

    public onSidenavLinkClicked() {
        if (this.sidenavMode !== 'side')
            this.sidenav.opened = false;
    }

    public toggleSidenav() {
        this.sidenav.opened = !this.sidenav.opened;
    }

    public logout(message?: string, redirectInfo: boolean = true) {
        if (message)
            this.snackBar.open(message, 'OK', {
                duration: 2000
            });

        // Log the user out
        this.auth.logout();

        const data = this.auth.lastValidAuthData;

        // We don't know if the next user will have access to the selected
        // schema
        this.schemaControl.reset();

        // Automatically redirect to the login page
        const query = redirectInfo && data !== null ? LoginComponent.createRedirectQuery({
            username: data.username,
            host: data.host,
            path: this.router.url
        }) : {};
        return this.router.navigate(['/login'], { queryParams: query });
    }

    private adjustSidenav(newWidth: number) {
        if (!this.auth.loggedIn) {
            this.sidenav.opened = false;
        } else {
            const alwaysShow = newWidth >= AppComponent.ALWAYS_SHOW_SIDENAV_WIDTH;
            this.sidenavMode = alwaysShow ? 'side' : 'over';
            this.sidenav.opened = alwaysShow;
        }
    }

    /**
     * Tries to determine the best schema to select by default. If the current
     * URL indicates a schema, that is selected if available. Otherwise, the
     * first schema that appears alphabetically is chosen. `information_schema`
     * will never be chosen unless it's the only schema.
     * @param {string[]} all A list of all schemas available to the user
     */
    private determineDefaultSchema(all: string[]) {
        const urlTree = this.router.parseUrl(this.router.url);
        // Get each segment of the URL. If the path is /foo/bar/baz, segments
        // will be ['foo', 'bar', 'baz'].
        const segments = urlTree.root.children.primary.segments.map((s) => s.path);

        if (segments.length > 1 && (segments[0] === 'tables' || segments[0] === 'forms')) {
            // The URL indicates a selected schema, pick it if the user has
            // access to it.
            const loadedSchema = segments[1];
            if (all.includes(loadedSchema)) {
                return loadedSchema;
            }
        }

        const sorted = _.sortBy(all);

        // Use the first schema when sorted alphabetically. Prefer not to use
        // information_schema since most users probably don't care about this
        if (sorted[0].toLocaleLowerCase() === 'information_schema' && sorted.length > 0)
            return sorted[1];
        return sorted[0];
    }
}
