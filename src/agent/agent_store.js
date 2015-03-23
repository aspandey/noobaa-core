/* jshint node:true */
'use strict';

var _ = require('lodash');
var Q = require('q');
var fs = require('fs');
var path = require('path');
var assert = require('assert');
var crypto = require('crypto');
var mkdirp = require('mkdirp');
var size_utils = require('../util/size_utils');
var Semaphore = require('noobaa-util/semaphore');
var dbg = require('noobaa-util/debug_module')(__filename);

module.exports = AgentStore;


/**
 *
 * AgentStore
 *
 */
function AgentStore(root_path) {
    this.root_path = root_path;
    this.blocks_path = path.join(this.root_path, 'blocks');
    this.hash_path = path.join(this.root_path, '.h');
    mkdirp.sync(this.blocks_path);
    mkdirp.sync(this.hash_path);
}


/**
 *
 * MemoryStore
 *
 * memory only alternative, for testing
 */
AgentStore.MemoryStore = MemoryStore;


/**
 *
 * GET_STATS
 *
 */
AgentStore.prototype.get_stats = function() {
    var self = this;
    return Q.all([
        self.get_usage(),
        self.get_alloc()
    ]).spread(function(usage, alloc) {
        return {
            alloc: alloc,
            used: usage.size,
        };
    });
};


/**
 *
 * GET_USAGE
 *
 */
AgentStore.prototype.get_usage = function() {
    var self = this;
    if (self._usage) {
        return self._usage;
    } else {
        return self._count_usage();
    }
};


/**
 *
 * GET_ALLOC
 *
 */
AgentStore.prototype.get_alloc = function() {
    var self = this;
    return self._read_config()
        .then(function(config) {
            return config && config.alloc || 0;
        });
};


/**
 *
 * SET_ALLOC
 *
 */
AgentStore.prototype.set_alloc = function(size) {
    var self = this;
    return self._read_config()
        .then(function(config) {
            config = config || {};
            config.alloc = size;
            return self._write_config(config);
        });
};


/**
 *
 * READ_BLOCK
 *
 */
AgentStore.prototype.read_block = function(block_id) {
    var self = this;
    var block_path = self._get_block_path(block_id);
    var hash_path = path.join(self.hash_path, block_id);
    dbg.log0('fs read block', block_path);
    return Q.all([
            Q.nfcall(fs.readFile, block_path),
            Q.nfcall(fs.readFile, hash_path)
            .then(null, function(err) {
                if (err.code === 'ENOENT') return;
                throw err;
            })
        ])
        .spread(function(data, hash_info) {
            if (hash_info) {
                var hash_val = crypto.createHash('sha256').update(data).digest('base64');
                hash_info = hash_info.toString().split(' ');
                var len = parseInt(hash_info[0], 10);
                var val = hash_info[1];
                if (len !== data.length || hash_val !== val) {
                    throw 'TAMPERING DETECTED';
                }
            }
            return data;
        });
};


/**
 *
 * WRITE_BLOCK
 *
 */
AgentStore.prototype.write_block = function(block_id, data) {
    var self = this;
    var block_path = self._get_block_path(block_id);
    var hash_path = path.join(self.hash_path, block_id);
    var file_stats;

    if (!Buffer.isBuffer(data) && typeof(data) !== 'string') {
        throw new Error('data is not a buffer/string');
    }

    var hash_val = crypto.createHash('sha256').update(data).digest('base64');
    var hash_info = data.length.toString(10) + ' ' + hash_val;

    return self._stat_block_path(block_path, true)
        .then(function(stats) {
            file_stats = stats;
            dbg.log0('fs write block', block_path, data.length, typeof(data), file_stats);

            // create/replace the block on fs
            return Q.all([
                Q.nfcall(fs.writeFile, block_path, data),
                Q.nfcall(fs.writeFile, hash_path, hash_info)
            ]);
        })
        .then(function() {
            if (self._usage) {
                self._usage.size += data.length;
                self._usage.count += 1;
                if (file_stats) {
                    self._usage.size -= file_stats.size;
                    self._usage.count -= 1;
                }
            }
        });
};


/**
 *
 * DELETE_BLOCKS
 *
 */
AgentStore.prototype.delete_blocks = function(block_ids) {
    var self = this;
    var ret = '';
    var tmp_usage = {
        size: 0,
        count: 0,
    };
    var delete_funcs = [];

    _.each(block_ids, function(block) {
        delete_funcs.push(function() {
            self._delete_block(block);
        });
    });

    //TODO: use q.allSettled with 10 concurrency
    Q.allSettled(_.map(delete_funcs, function(call) {
            return call();
        }))
        .then(function(results) {
            dbg.log0("  NB:: results", results);
            _.each(results, function(r) {
                if (r.state === 'fulfilled') {
                    dbg.log0("  NB:: fulfilled with size ", r.value, " r is ", r);
                    tmp_usage.size += r.value;
                    tmp_usage.count += 1;
                } else {
                    ret = r.reason;
                }
            });
            dbg.log0("  NB:: updating size", tmp_usage.size, "count", tmp_usage.count);
            if (self._usage) {
                self._usage.size -= tmp_usage.size;
                self._usage.count -= tmp_usage.count;
            }
        });

    //TODO: should we return ret here ?
};


/**
 *
 * STAT_BLOCK
 *
 */
AgentStore.prototype.stat_block = function(block_id) {
    var self = this;
    var block_path = self._get_block_path(block_id);
    return self._stat_block_path(block_path);
};



// PRIVATE //////////////////////////////////////////////////////////

/**
 *
 * _delete_block
 *
 */
AgentStore.prototype._delete_block = function(block_id) {
    var self = this;
    var block_path = self._get_block_path(block_id);
    var file_stats;

    return self._stat_block_path(block_path, true)
        .then(function(stats) {
            file_stats = stats;
            dbg.log0('delete block', block_path, 'stats', file_stats);
            if (file_stats) {
                return Q.nfcall(fs.unlink(block_path));
            }
        })
        .then(function() {
            dbg.log0("  NB:: in _delete with size of ", file_stats.size);
            return file_stats.size;
        });
};


/**
 *
 * _get_block_path
 *
 */
AgentStore.prototype._get_block_path = function(block_id) {
    return path.join(this.blocks_path, block_id);
};


/**
 *
 * _stat_block_path
 *
 */
AgentStore.prototype._stat_block_path = function(block_path, resolve_missing) {
    return Q.nfcall(fs.stat, block_path)
        .then(null, function(err) {
            if (resolve_missing && err.code === 'ENOENT') return;
            throw err;
        });
};

/**
 *
 * _read_config
 *
 */
AgentStore.prototype._read_config = function() {
    var self = this;
    var config_file = path.join(self.root_path, 'config');
    return Q.nfcall(fs.readFile, config_file)
        .then(function(data) {
            return JSON.parse(data);
        }, function(err) {
            if (err.code === 'ENOENT') return;
            throw err;
        });
};

/**
 *
 * _write_config
 *
 */
AgentStore.prototype._write_config = function(config) {
    var self = this;
    var config_file = path.join(self.root_path, 'config');
    var data = JSON.stringify(config);
    return Q.nfcall(fs.writeFile, config_file, data);
};


/**
 *
 * _count_usage
 *
 */
AgentStore.prototype._count_usage = function() {
    var self = this;
    var sem = new Semaphore(10);
    return disk_usage(self.blocks_path, sem, true)
        .then(function(usage) {
            dbg.log0('counted disk usage', usage);
            self._usage = usage; // object with properties size and count
            return usage;
        });
};




// UTILS //////////////////////////////////////////////////////////



/**
 *
 * DISK_USAGE
 *
 */
function disk_usage(file_path, semaphore, recurse) {
    // surround fs io with semaphore
    return semaphore.surround(function() {
            return Q.nfcall(fs.stat, file_path);
        })
        .then(function(stats) {

            if (stats.isFile()) {
                return {
                    size: stats.size,
                    count: 1,
                };
            }

            if (stats.isDirectory() && recurse) {
                // surround fs io with semaphore
                return semaphore.surround(function() {
                        return Q.nfcall(fs.readdir, file_path);
                    })
                    .then(function(entries) {
                        return Q.all(_.map(entries, function(entry) {
                            var entry_path = path.join(file_path, entry);
                            return disk_usage(entry_path, semaphore, recurse);
                        }));
                    })
                    .then(function(res) {
                        var size = 0;
                        var count = 0;
                        for (var i = 0; i < res.length; i++) {
                            if (!res[i]) continue;
                            size += res[i].size;
                            count += res[i].count;
                        }
                        return {
                            size: size,
                            count: count,
                        };
                    });
            }
        });
}



/**
 *
 * MemoryStore
 *
 * memory only alternative, for testing
 */
function MemoryStore() {
    this._alloc = 0;
    this._used = 0;
    this._count = 0;
    this._blocks = {};
    this.get_stats = function() {
        return {
            alloc: this._alloc,
            used: this._used,
            count: this._count,
        };
    };
    this.get_alloc = function() {
        return this._alloc;
    };
    this.set_alloc = function(size) {
        this._alloc = size;
    };
    this.get_usage = function() {
        return {
            size: this._used,
            count: this._count,
        };
    };
    this.read_block = function(block_id) {
        return this._blocks[block_id];
    };
    this.write_block = function(block_id, data) {
        var b = this._blocks[block_id];
        if (b) {
            this._used -= b.length;
            this._count -= 1;
        }
        this._blocks[block_id] = data;
        this._used += data.length;
        this._count += 1;
    };
    this.delete_block = function(block_id) {
        var b = this._blocks[block_id];
        if (b) {
            this._used -= b.length;
            this._count -= 1;
        }
        delete this._blocks[block_id];
    };
    this.stat_block = function(block_id) {
        var b = this._blocks[block_id];
        return b && {
            size: b.length
        };
    };
}
