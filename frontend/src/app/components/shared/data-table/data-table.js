import template from './data-table.html';
import ColumnViewModel from './column';
import * as defaultCellTemplates from './cell-templates';
import Disposable from 'disposable';
import ko from 'knockout';
import { noop, isFunction } from 'utils';

const scrollThrottle = 750;

function generateRowTemplate(columns) {
    return `<tr data-bind="css: $component.getSelectCss($data), click: $component.selectRow">${
        columns.map(
            ({ name, css, cellTemplate }) =>
                `<td data-bind="css:'${css}',let:{$data:${name},$rawData:${name}}">${
                    cellTemplate
                }</td>`
        )
        .join('\n')
    }</tr> `;
}

class DataTableViewModel extends Disposable {
    constructor(params, customTemplates) {
        super();

        let {
            columns = [],
            rowFactory = noop,
            data,
            sorting,
            selected,
            selectedProp,
            scroll = ko.observable(),
            emptyMessage
        } = params;

        let cellTemplates = Object.assign(
            {},
            defaultCellTemplates,
            customTemplates
        );

        this.columns = ko.pureComputed(
            () => ko.unwrap(columns).map(
                value => new ColumnViewModel(value, cellTemplates)
            )
        );

        // Generate a row template
        this.rowTemplate = ko.pureComputed(
            () => generateRowTemplate(ko.unwrap(this.columns))
        );

        this.rowFactory = rowFactory;

        this.rows = ko.observableArray();

        this.isEmpty = ko.pureComputed(
            () => this.rows().length === 0
        );

        // Init the table rows.
        this.updateRows(data);

        // Update the table rows on data change event.
        if (ko.isObservable(data)) {
            this.addToDisposeList(
                data.subscribe(
                    () => this.updateRows(data)
                )
            );
        }

        this.sorting = sorting;

        this.scroll = scroll.extend({
            rateLimit: {
                method: 'notifyWhenChangesStop',
                timeout: scrollThrottle
            }
        });

        console.warn(ko.isObservableArray)

        this.selected = selected;
        this.selectedProp = selectedProp;
        this.allowSelection = selectedProp && ko.isWritableObservable(selected);
        this.selectRow = this.selectRow.bind(this);

        this.emptyMessage = emptyMessage;
    }

    updateRows(data) {
        let curr = this.rows().length;
        let target = (ko.unwrap(data) || []).length;
        let diff = curr - target;

        if (diff < 0) {
            for (let i = curr; i < target; ++i) {
                this.rows.push(
                    this.rowFactory(() => (ko.unwrap(data) || [])[i])
                );
            }

        } else if (diff > 0) {
            while(diff-- > 0) {
                let row = this.rows.pop();
                isFunction(row.dispose) && row.dispose();
            }
        }
    }

    getSelectCss(row) {
        let value = ko.unwrap(row[this.selectedProp]);
        let isSelected = this.allowSelection && this.selected() === value;
        return isSelected ? 'selected' : null;
    }

    getSortCss(sortKey) {
        if (!this.sorting || !sortKey) {
            return '';
        }

        let { sortBy, order } = ko.unwrap(this.sorting) || {};
        return `sortable ${
            sortBy === sortKey ? (order === 1 ? 'des' : 'asc') : ''
        }`;
    }

    sortBy(sortKey) {
        let { sortBy, order } = this.sorting();
        this.sorting({
            sortBy:sortKey,
            order: sortBy === sortKey ? 0 - order : 1
        });
    }

    selectRow(row) {
        if (this.allowSelection) {
            let value = ko.unwrap(row[this.selectedProp]);
            this.selected(value);
        }
    }
}

function viewModelFactory(params, info) {
    let cellTemplates = info.templateNodes
        .filter(
            ({ nodeType }) => nodeType === 1
        )
        .reduce(
            (templates, template) => {
                let name = template.getAttribute('name');
                let html = template.innerHTML;
                templates[name] = html;
                return templates;
            },
            {}
        );

    return new DataTableViewModel(params, cellTemplates);
}

export default {
    viewModel: { createViewModel: viewModelFactory },
    template: template
};
