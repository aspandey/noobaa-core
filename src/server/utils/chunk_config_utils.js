/* Copyright (C) 2016 NooBaa */
'use strict';

const _ = require('lodash');
const config = require('../../../config');
const system_store = require('../system_services/system_store').get_instance();


function new_chunk_code_config_defaults(chunk_coder_config) {
    const ccc = Object.assign({
        digest_type: config.CHUNK_CODER_DIGEST_TYPE,
        frag_digest_type: config.CHUNK_CODER_FRAG_DIGEST_TYPE,
        compress_type: config.CHUNK_CODER_COMPRESS_TYPE,
        cipher_type: config.CHUNK_CODER_CIPHER_TYPE,
    }, chunk_coder_config);

    if (ccc.parity_frags) {
        // Erasure Codes
        ccc.replicas = ccc.replicas || 1;
        ccc.data_frags = ccc.data_frags || 1;
        ccc.parity_type = ccc.parity_type || config.CHUNK_CODER_EC_PARITY_TYPE;
    } else {
        // Data Copies
        ccc.replicas = ccc.replicas || 3;
        ccc.data_frags = ccc.data_frags || 1;
        ccc.parity_frags = 0;
        delete ccc.parity_type;
    }

    return ccc;
}


function resolve_chunk_config(chunk_coder_config, account, system) {

    // Default config can be specified in the account / system level too
    // It will only be used if no specific config was requested
    const global_chunk_config = chunk_coder_config ?
        undefined :
        account.default_chunk_config || system.default_chunk_config;
    if (global_chunk_config) return { chunk_config: global_chunk_config };

    // Fill the config with default values we assume the caller
    // to send only the values that it want to change from the default
    const chunk_coder_config_full = new_chunk_code_config_defaults(chunk_coder_config);

    // Look for an existing config item in the system store
    // by matching the properties of the coder config
    const existing_chunk_config = _.find(system.chunk_configs_by_id, _.matches({ chunk_coder_config_full }));
    if (existing_chunk_config) return { chunk_config: existing_chunk_config };

    // The fallback is always to add a new config with the properties as requested by the caller
    const insert_chunk_config = {
        _id: system_store.generate_id(),
        system: system._id,
        chunk_coder_config: chunk_coder_config_full,
    };
    return { chunk_config: insert_chunk_config, insert_chunk_configs: [insert_chunk_config] };
}


exports.new_chunk_code_config_defaults = new_chunk_code_config_defaults;
exports.resolve_chunk_config = resolve_chunk_config;