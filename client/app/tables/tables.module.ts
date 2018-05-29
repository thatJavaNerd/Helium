import { CommonModule } from '@angular/common';
import { NgModule } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import {
    MatButtonModule,
    MatCardModule, MatCheckboxModule, MatFormFieldModule, MatIconModule,
    MatPaginatorModule,
    MatProgressBarModule, MatSelectModule, MatSortModule, MatTableModule
} from '@angular/material';
import { CoreModule } from '../core/core.module';
import { DatatableComponent } from './datatable/datatable.component';
import { TableHostComponent } from './table-host/table-host.component';
import { TableRoutingModule } from './table-routing.module';

import { DynamicFormsModule } from '../dynamic-forms/dynamic-forms.module';
import { ApiDataSource } from './api-data-source/api-data-source';
import { FilterManagerComponent } from './filter-manager/filter-manager.component';
import { FilterProviderService } from './filter-provider/filter-provider.service';
import { FilterComponent } from './filter/filter.component';
import { LayoutHelper } from './layout-helper/layout-helper';
import { SortIndicatorComponent } from './sort-indicator/sort-indicator.component';

@NgModule({
    imports: [
        CommonModule,
        CoreModule,
        DynamicFormsModule,
        MatButtonModule,
        MatCardModule,
        MatCheckboxModule,
        MatFormFieldModule,
        MatIconModule,
        MatPaginatorModule,
        MatProgressBarModule,
        MatSelectModule,
        MatSortModule,
        MatTableModule,
        ReactiveFormsModule,
        TableRoutingModule
    ],
    declarations: [
        DatatableComponent,
        FilterComponent,
        FilterManagerComponent,
        SortIndicatorComponent,
        TableHostComponent
    ],
    exports: [
        DatatableComponent
    ],
    providers: [
        ApiDataSource,
        FilterProviderService,
        LayoutHelper
    ]
})
export class TablesModule {}
