/* Copyright (C) 2016 NooBaa */
/* eslint-env mongo */
'use strict';

/*
 * mongodb script to restore the initial state of the database
 *
 * usage: mongo nbcore mongodb_init.js
 *
 */
db.getSiblingDB("nbcore").datablocks.remove({});
db.getSiblingDB("nbcore").datachunks.remove({});
db.getSiblingDB("nbcore").objectparts.remove({});
db.getSiblingDB("nbcore").objectmds.remove({});
db.getSiblingDB("nbcore").tiers.update({
    name: {
        $nin: [/files#.*/]
    }
}, {
    $set: {
        pool: db.getSiblingDB("nbcore").pools.find({
            name: 'default_pool'
        })[0]._id
    }
});
db.getSiblingDB("nbcore").pools.remove({
    name: {
        $ne: 'default_pool'
    }
});
db.getSiblingDB("nbcore").tiers.remove({
    name: {
        $nin: [/files#.*/]
    }
});
db.getSiblingDB("nbcore").tieringpolicies.remove({
    name: {
        $nin: [/files#.*/]
    }
});
db.getSiblingDB("nbcore").buckets.remove({
    name: {
        $ne: 'files'
    }
});

db.getSiblingDB("nbcore").buckets.updateMany({}, {
    $unset: {
        cloud_sync: true
    },
    $set: {
        storage_stats: {
            chunks_capacity: 0,
            blocks_size: 0,
            objects_size: 0,
            objects_count: 0,
            objects_hist: [],
            last_update: Date.now()
        }
    }
});

// We assign all of the nodes to the default_pool, because we've removed all of the pools
db.getSiblingDB("nbcore").nodes.update({}, {
    $set: {
        pool: db.getSiblingDB("nbcore").pools.find({
            name: 'default_pool'
        })[0]._id
    },
    $unset: {
        issues_report: 1
    }
}, {
    multi: true
});
// Removing all accounts except Support and Owner
db.getSiblingDB("nbcore").accounts.remove({
    email: {
        $nin: ['demo@noobaa.com', 'support@noobaa.com']
    }
});

// Update owner allowed_buckets to files bucket only
db.getSiblingDB("nbcore").accounts.update({
    email: 'demo@noobaa.com'
}, {
    $set: {
        allowed_buckets: [db.getSiblingDB("nbcore").buckets.find({
            name: 'files'
        })[0]._id]
    }
});

// Removing roles of the deleted accounts, except demo and support (which doesn't have a role)
db.getSiblingDB("nbcore").roles.remove({
    account: {
        $nin: [db.getSiblingDB("nbcore").accounts.find({
            email: 'demo@noobaa.com'
        })[0]._id]
    }
});

//clean cloud sync credential cache
db.getSiblingDB("nbcore").accounts.updateMany({}, {
    $unset: {
        sync_credentials_cache: true
    }
});
