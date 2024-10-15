/* Copyright (C) 2016 NooBaa */
'use strict';

const s3_utils = require('../s3_utils');
const dbg = require('../../../util/debug_module')(__filename);
/**
 * http://docs.aws.amazon.com/AmazonS3/latest/API/RESTServiceGET.html
 */
async function list_buckets(req) {

    const params = {
        continuation_token: req.query['continuation-token'],
        max_buckets: req.query['max-buckets'] ? Number(req.query['max-buckets']) : undefined
    };

    dbg.error("params.max_buckets:", params.max_buckets, "params.continuation_token:", params.continuation_token);
    const reply = await req.object_sdk.list_buckets(params);
    const date = s3_utils.format_s3_xml_date(new Date());
    return {
        ListAllMyBucketsResult: {
            Owner: s3_utils.DEFAULT_S3_USER,
            Buckets: reply.buckets.map(bucket => ({
                Bucket: {
                    Name: bucket.name.unwrap(),
                    CreationDate: bucket.creation_date ? s3_utils.format_s3_xml_date(bucket.creation_date) : date,
                }
            })),
            ContinuationToken: reply.continuation_token,
        }
    };
}

module.exports = {
    handler: list_buckets,
    body: {
        type: 'empty',
    },
    reply: {
        type: 'xml',
    },
};
