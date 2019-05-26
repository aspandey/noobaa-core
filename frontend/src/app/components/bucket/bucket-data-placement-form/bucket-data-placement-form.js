/* Copyright (C) 2016 NooBaa */

import template from './bucket-data-placement-form.html';
import ConnectableViewModel from 'components/connectable';
import ko from 'knockout';
import { deepFreeze } from 'utils/core-utils';
import { usingInternalStorageWarningTooltip } from 'knowledge-base-articles.json';
import { formatSize } from 'utils/size-utils';
import { openAddTierModal, openBucketPlacementSummaryModal } from 'action-creators';

const addTierTooltips = deepFreeze({
    usingInternal: 'Adding more tiers will be enabled after adding storage resources to tier 1',
    hasMaxTiers: 'Adding more tiers will be available in the following versions of NooBaa'
});

const internalWarningTooltip = deepFreeze({
    template: 'textAndLink',
    text: {
        text:`
            Using the system internal storage is not recommended due to low performance.
            Please add storage resources(Local nodes or cloud resources).
        `,
        link: {
            text: 'Learn how to add storage to NooBaa',
            href: usingInternalStorageWarningTooltip
        }
    }
});

function _findInternalStorageUsage(bucket) {
    const pair = Object.entries(bucket.usageDistribution.resources)
        .find(pair => pair[0].startsWith('INTERNAL'));

    return pair ? pair[1] : 0;
}

class BucketDataPlacementFormViewModel extends ConnectableViewModel {
    dataReady = ko.observable();
    bucketName = ko.observable();
    tierNames = ko.observableArray();
    tierLabels = ko.observableArray();
    isAddTierDisabled = ko.observable();
    addTierTooltip = ko.observable();
    isInternalWarningVisible = ko.observable();
    internalWarningTooltip = internalWarningTooltip;
    internalStorageUsage = ko.observable();
    hasMultipleTiers = ko.observable();

    selectState(state, params) {
        const { buckets, system } = state;
        return [
            params.bucketName,
            buckets && buckets[params.bucketName],
            system && system.internalStorage

        ];
    }

    mapStateToProps(bucketName, bucket, internalStorage) {
        if (!bucket || !internalStorage) {
            ko.assignToProps(this, {
                dataReady: false
            });

        } else {
            const { tiers } = bucket.placement;
            const isUsingInternalStorage = tiers[0].policyType === 'INTERNAL_STORAGE';
            const tierNames = tiers.map(tier => tier.name);
            const tierLabels = tiers.map((_, i) => `Tier ${i + 1}`);
            const isAddTierDisabled = isUsingInternalStorage || tierNames.length > 1;
            const addTierTooltip = {
                text:
                    (isUsingInternalStorage && addTierTooltips.usingInternal) ||
                    (tierNames.length > 1 && addTierTooltips.hasMaxTiers) ||
                    '',
                align: 'end'
            };

            const internalStorageUsage = `${
                formatSize(_findInternalStorageUsage(bucket))
            } of ${
                formatSize(internalStorage.total)
            }`;

            ko.assignToProps(this, {
                dataReady: true,
                bucketName,
                tierNames,
                tierLabels,
                isInternalWarningVisible: isUsingInternalStorage,
                isAddTierDisabled,
                addTierTooltip,
                internalStorageUsage,
                hasMultipleTiers: tierNames.length > 1
            });
        }
    }

    onAddTer() {
        this.dispatch(openAddTierModal(this.bucketName()));
    }

    onOpenTiersFlow() {
        this.dispatch(openBucketPlacementSummaryModal(this.bucketName()));
    }
}

export default {
    viewModel: BucketDataPlacementFormViewModel,
    template: template
};