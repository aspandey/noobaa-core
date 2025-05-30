/* Copyright (C) 2016 NooBaa */
'use strict';

const _ = require('lodash');
const AWS = require('aws-sdk');
const dbg = require('../util/debug_module')(__filename);
const url = require('url');
const path = require('path');
const crypto = require('crypto');
const S3Error = require('../endpoint/s3/s3_errors').S3Error;
const http_utils = require('./http_utils');
const time_utils = require('./time_utils');
const { RpcError } = require('../rpc');


///////////////////////////////////////
//                V4                 //
///////////////////////////////////////


/**
 * See: http://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-auth-using-authorization-header.html
 * Example:
 *      Authorization: AWS4-HMAC-SHA256
 *          Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,
 *          SignedHeaders=host;range;x-amz-date,
 *          Signature=fe5f80f77d5fa3beca038a248ff027d0445342fe2855ddc963176630326f1024
 * Notes:
 * - Cyberduck does not include spaces after the commas
 */
function _authenticate_header_v4(req) {
    const v4 = req.headers.authorization.match(
        /^AWS4-HMAC-SHA256 Credential=(\S*),\s*SignedHeaders=(\S*),\s*Signature=(\S*)$/
    );
    if (!v4) {
        dbg.warn('Could not match AWS V4 Authorization:', req.headers.authorization);
        throw new S3Error(S3Error.InvalidArgument);
    }
    const credentials = v4[1].split('/', 5);
    const signed_headers = v4[2];
    const xamzdate = req.headers['x-amz-date'];
    const region = credentials[2];
    const service = credentials[3];

    // see http://docs.aws.amazon.com/general/latest/gr/sigv4-date-handling.html
    if (!xamzdate.startsWith(credentials[1])) {
        throw new Error('Mismatching date in Authorization Credential and x-amz-date');
    }

    return {
        access_key: credentials[0],
        signature: v4[3],
        string_to_sign: _string_to_sign_v4(req, signed_headers, xamzdate, region, service),
        extra: {
            xamzdate,
            region,
            service,
        },
    };
}

/**
 * See: http://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
 * Example:
 *      https://s3.amazonaws.com/examplebucket/test.txt
 *          ?X-Amz-Algorithm=AWS4-HMAC-SHA256
 *          &X-Amz-Credential=<your-access-key-id>/20130721/us-east-1/s3/aws4_request
 *          &X-Amz-Date=20130721T201207Z
 *          &X-Amz-Expires=86400
 *          &X-Amz-SignedHeaders=host
 *          &X-Amz-Signature=<signature-value>
 */
function _authenticate_query_v4(req) {
    const credentials = req.query['X-Amz-Credential'].split('/', 5);
    const signed_headers = req.query['X-Amz-SignedHeaders'];
    const xamzdate = req.query['X-Amz-Date'];
    const region = credentials[2];
    const service = credentials[3];

    // see http://docs.aws.amazon.com/general/latest/gr/sigv4-date-handling.html
    if (!xamzdate.startsWith(credentials[1])) {
        throw new Error('Mismatching date in X-Amz-Credential and X-Amz-Date');
    }

    return {
        access_key: credentials[0],
        signature: req.query['X-Amz-Signature'],
        string_to_sign: _string_to_sign_v4(req, signed_headers, xamzdate, region, service),
        extra: {
            xamzdate,
            region,
            service,
        },
    };
}

const EMPTY_SHA256 = crypto.createHash('sha256').digest('hex');

function _string_to_sign_v4(req, signed_headers, xamzdate, region, service) {
    const aws_request = _aws_request(req, region, service);
    const v4 = new AWS.Signers.V4(aws_request, service, 'signatureCache');

    // If Signed Headers param doesn't exist we sign everything in order to support
    // chunked upload: http://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-streaming.html
    const signed_headers_set = signed_headers ?
        new Set(signed_headers.split(';')) : null;

    v4.isSignableHeader = key =>
        !signed_headers_set ||
        signed_headers_set.has(key.toLowerCase());

    v4.hexEncodedBodyHash = () => req.content_sha256_sig || EMPTY_SHA256;

    const canonical_str = v4.canonicalString();
    const string_to_sign = v4.stringToSign(xamzdate);
    dbg.log1('_string_to_sign_v4',
        'method', aws_request.method,
        'pathname', aws_request.pathname(),
        'search', aws_request.search(),
        'headers', aws_request.headers,
        'region', aws_request.region,
        'canonical_str', '\n' + canonical_str + '\n',
        'string_to_sign', '\n' + string_to_sign + '\n');

    return string_to_sign;
}

function _check_expiry_query_v4(request_date, expires_seconds) {
    const now = Date.now();
    const expires = (new Date(time_utils.parse_amz_date(request_date)).getTime()) + (Number(expires_seconds) * 1000);
    if (now > expires) {
        throw new S3Error(S3Error.RequestExpired);
    }
}



///////////////////////////////////////
//                S3                 //
///////////////////////////////////////


function _authenticate_header_s3(req) {
    const s3 = req.headers.authorization.match(
        /^AWS (\w+):(\S+)$/
    );
    if (!s3) {
        dbg.warn('Could not match AWS S3 Authorization:', req.headers.authorization);
        throw new S3Error(S3Error.InvalidArgument);
    }
    return {
        access_key: s3[1],
        signature: s3[2],
        string_to_sign: _string_to_sign_s3(req),
    };
}

function _authenticate_query_s3(req) {
    return {
        access_key: req.query.AWSAccessKeyId,
        signature: req.query.Signature,
        string_to_sign: _string_to_sign_s3(req),
    };
}

function _string_to_sign_s3(req) {
    const aws_request = _aws_request(req);
    const s3 = new AWS.Signers.S3(aws_request);
    aws_request.headers['presigned-expires'] = req.query.Expires || req.headers.date;
    const string_to_sign = s3.stringToSign();
    dbg.log1('_string_to_sign_s3',
        'method', aws_request.method,
        'pathname', aws_request.pathname(),
        'search', aws_request.search(),
        'headers', aws_request.headers,
        'string_to_sign', '\n' + string_to_sign + '\n');
    return string_to_sign;
}

function _check_expiry_query_s3(expires_epoch) {
    const now = Date.now();
    const expires = Number(expires_epoch) * 1000;
    if (now > expires) {
        throw new S3Error(S3Error.RequestExpired);
    }
}


///////////////////////////////////////
//             GENERAL               //
///////////////////////////////////////


const HEADERS_MAP_FOR_AWS_SDK = {
    'authorization': 'Authorization',
    'content-md5': 'Content-MD5',
    'content-type': 'Content-Type',
    'cache-control': 'Cache-Control',
    'x-amz-date': 'X-Amz-Date',
    'x-amz-content-sha256': 'X-Amz-Content-Sha256',
    'x-amz-security-token': 'x-amz-security-token',
    'presigned-expires': 'presigned-expires',
};

function _aws_request(req, region, service) {
    const v2_signature = _.isUndefined(region) && _.isUndefined(service);
    const u = url.parse(req.originalUrl.replace(/%2F/g, '/'), true);
    // for S3 we decode and escape the URI components to handle cpp sdk behaior, which for a few charecters (e.g. =,?$@) 
    // it does not escape it in the request but escapes it for the signature calculations.
    // see https://github.com/noobaa/noobaa-core/issues/7784 
    const pathname = service === 's3' ?
        u.pathname.split('/').map(c => AWS.util.uriEscape(decodeURIComponent(c))).join('/') :
        path.normalize(decodeURI(u.pathname));
    const query = _.omit(
        req.query,
        'X-Amz-Signature', 'Signature', 'Expires', 'AWSAccessKeyId'
    );
    const query_to_string = AWS.util.queryParamsToString(query);
    const equals_handling = v2_signature ? query_to_string.replace(/=$/, '').replace(/=&/g, '&') :
        query_to_string;
    const search_string = u.search ? equals_handling : '';
    const headers_for_sdk = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i].toLowerCase();
        const value = req.rawHeaders[i + 1];
        // mapping the headers from nodejs lowercase keys to AWS SDK capilization
        // using predefined map for specific cases used by the signers
        const sdk_key =
            HEADERS_MAP_FOR_AWS_SDK[key] ||
            (key.split('-')
                .map(_.capitalize)
                .join('-'));
        if (headers_for_sdk[sdk_key]) {
            headers_for_sdk[sdk_key] += ',' + value;
        } else {
            headers_for_sdk[sdk_key] = value;
        }
    }
    const aws_request = {
        region: region,
        method: req.method,
        path: v2_signature ? (u.pathname + (search_string ? '?' + search_string : '')) : req.originalUrl,
        headers: headers_for_sdk,
        search: () => search_string,
        pathname: () => pathname,
        virtualHostedBucket: req.virtual_hosted_bucket,
    };
    return aws_request;
}

/**
 *
 * Prepare HTTP request (express) authentication for sending to auth_server
 *
 */
function make_auth_token_from_request(req) {
    if (req.headers.authorization) {
        if (req.headers.authorization.startsWith('AWS4-HMAC-SHA256')) {
            return _authenticate_header_v4(req);
        }
        if (req.headers.authorization.startsWith('AWS ')) {
            return _authenticate_header_s3(req);
        }
        // In cases where some clients send a presigned url with their added on autorization headers
        // We do not want to fail the request and attempt to authenticate it below
        // If we do not have any algorithm or signatures in the request then we handle the request as annonymous
        dbg.warn('Unrecognized Authorization Header:', req.headers.authorization);
    }
    if (req.query['X-Amz-Algorithm'] === 'AWS4-HMAC-SHA256') {
        return _authenticate_query_v4(req);
    }
    if (req.query.AWSAccessKeyId && req.query.Signature) {
        return _authenticate_query_s3(req);
    }
    dbg.warn('Anonymous request:', req.method, req.originalUrl, req.headers);
}


/**
 *
 * checking the expiry of presigned requests
 *
 * TODO check_expiry checks the http request, but will be best to check_expiry on auth_token in the server
 *  the problem is that currently we don't have the needed fields in the token...
 *
 */
function check_request_expiry(req) {
    if (req.query['X-Amz-Date'] && req.query['X-Amz-Expires']) {
        _check_expiry_non_negative(req.query['X-Amz-Expires']);
        _check_expiry_limit(req.query['X-Amz-Expires']);
        _check_expiry_query_v4(req.query['X-Amz-Date'], req.query['X-Amz-Expires']);
    } else if (req.query.Expires) {
        const expiry_seconds = req.query.Expires - Math.ceil(Date.now() / 1000);
        _check_expiry_limit(expiry_seconds);
        _check_expiry_query_s3(req.query.Expires);
    }
}

// expiry_seconds limit is 7 days = 604800 seconds
function _check_expiry_limit(expiry_seconds) {
    if (Number(expiry_seconds) > 604800) {
        throw new S3Error(S3Error.AuthorizationQueryParametersErrorWeek);
    }
}

/**
 * _check_expiry_non_negative converts the expiry_seconds that we got
 * from eq.query['X-Amz-Expires'] to number and checks that it is non negative number
 * (throws an error otherwise)
 * Note: we don't run it in the condition of epoch time (req.query.expires)
 * @param {string} expiry_seconds 
 */
function _check_expiry_non_negative(expiry_seconds) {
    if (Number(expiry_seconds) < 0) {
        throw new S3Error(S3Error.AuthorizationQueryParametersErrorNonNegative);
    }
}

/**
 *
 * Calculates AWS signature based on auth_server request
 *
 */
function get_signature_from_auth_token(auth_token, secret_key) {

    // using S3 signer unless V4
    if (!auth_token.extra) {
        const s3 = new AWS.Signers.S3();
        return s3.sign(secret_key, auth_token.string_to_sign);
    }

    const aws_request = {
        region: auth_token.extra.region,
    };
    const aws_credentials = {
        accessKeyId: auth_token.access_key,
        secretAccessKey: secret_key,
    };

    // string_to_sign is already calculated in the proxy,
    // we override the signer function to just return the calculated string
    const v4 = new AWS.Signers.V4(aws_request, auth_token.extra.service, 'signatureCache');
    v4.stringToSign = () => auth_token.string_to_sign;
    return v4.signature(aws_credentials, auth_token.extra.xamzdate);
}

function authorize_client_request(req) {
    req.port = req.port || 80;
    req.host = req.host || 'localhost';
    req.body = req.body || '';
    req.key = req.key || 'first.key';
    req.bucket = req.bucket || 'first.bucket';
    req.method = req.method || 'GET';
    req.region = req.region || 'us-east-1';
    req.service = req.service || 's3';
    req.access_key = req.access_key || '123';
    req.secret_key = req.secret_key || 'abc';
    req.credentials = { accessKeyId: req.access_key, secretAccessKey: req.secret_key };
    req.pathname = () => `/${req.bucket}/${req.key}`;
    req.search = () => (req.query ? '?' + AWS.util.queryParamsToString(req.query) : '');
    req.path = `${req.pathname()}${req.search()}`;
    req.headers = req.headers || {};
    req.headers.Host = req.host;
    req.headers['Content-Length'] = req.body.length;
    req.headers['User-Agent'] = 'Smith';
    req.headers['X-Amz-Date'] = new Date().toISOString().replace(/-|:|\.\d{3}/g, '');
    req.headers['X-Amz-Content-Sha256'] = crypto.createHash('sha256').update(req.body).digest('hex');
    const v4 = new AWS.Signers.V4(req, req.service, 'signatureCache');
    req.headers.Authorization = v4.authorization(req.credentials, req.headers['X-Amz-Date']);
}

// mutual code of S3, STS and IAM services
// sdk - this can be: object_sdk, sts_sdk or account_sdk
function authenticate_request_by_service(req, sdk) {
    const auth_token = make_auth_token_from_request(req);
    if (auth_token) {
        auth_token.client_ip = http_utils.parse_client_ip(req);
    }
    if (req.session_token) {
        auth_token.access_key = req.session_token.assumed_role_access_key;
        auth_token.temp_access_key = req.session_token.access_key;
        auth_token.temp_secret_key = req.session_token.secret_key;
    }
    sdk.set_auth_token(auth_token);
    check_request_expiry(req);
}

// mutual code of S3, STS and IAM services
// 1 - check access key status (in case deactivated property true)
// 2 - check secret_key signature (in case we should check the signature)
function authorize_request_account_by_token(token, requesting_account) {
    if (!requesting_account) _throw_error_authorize_request_account_by_token('requesting_account');
    if (!token) _throw_error_authorize_request_account_by_token('token');

    const access_key_id_to_find = token.access_key;
    const access_key_obj = _.find(requesting_account.access_keys,
        item => item.access_key.unwrap() === access_key_id_to_find);

    if (!access_key_obj) {
        // we should never get here
        dbg.error(`authorize_request_account_by_token: could not find access_key_id ${access_key_id_to_find}`);
        throw new RpcError('INVALID_ACCESS_KEY_ID', `Account with access_key not found`);
    }

    if (access_key_obj.deactivated) { // if it is undefined then it is Active by default
        dbg.error(`authorize_request_account_by_token: access key id ${access_key_id_to_find} ` +
            `status is Inactive`);
        throw new RpcError('DEACTIVATED_ACCESS_KEY_ID', `Account with access_key deactivated`);
    }

    if (!access_key_obj.secret_key) {
        // Should we never get here? 
        // (with a question mark since we had optional chaining)
        _throw_error_authorize_request_account_by_token('secret_key');
    }

    const signature_secret = token.temp_secret_key || access_key_obj.secret_key.unwrap();
    const signature = get_signature_from_auth_token(token, signature_secret);
    if (token.signature !== signature) {
        throw new RpcError('SIGNATURE_DOES_NOT_MATCH', `Signature that was calculated did not match`);
    }
}

/**
 * @param {string} component
 */
function _throw_error_authorize_request_account_by_token(component) {
    dbg.error(`authorize_request_account_by_token: we don't have ${component}`);
    throw new RpcError('INTERNAL_ERROR', `Needs ${component} for authorize request account`);
}


exports.make_auth_token_from_request = make_auth_token_from_request;
exports.check_request_expiry = check_request_expiry;
exports.get_signature_from_auth_token = get_signature_from_auth_token;
exports.authorize_client_request = authorize_client_request;
exports.authenticate_request_by_service = authenticate_request_by_service;
exports.authorize_request_account_by_token = authorize_request_account_by_token;
