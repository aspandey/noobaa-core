'use strict';

var _ = require('lodash');
var P = require('../src/util/promise');
var WS = require('ws');
var util = require('util');
var buffer_utils = require('../util/buffer_utils');
var dbg = require('../util/debug_module')(__filename);

module.exports = SimpleWS;

var STATE_INIT = 'init';
var STATE_HANDSHAKE = 'handshake';
var STATE_READY = 'ready';
var STATE_CLOSED = 'closed';

var OP_HANDSHAKE = 'handshake';
var OP_KEEPALIVE = 'keepalive';
var OP_MESSAGE = 'msg';


/**
 * Wrapper for WebSocket with several features:
 *
 * - send and receive binary Buffer or JSON (handles parsing/encoding)
 *
 * - lazy connect - set options.lazyConnect=true
 *      to connect only upon call to send.
 *
 * - idle close set options.idleCloseTimeout=60000
 *      to close socket after timeout of being idle (no send/receive ignoring keepalives)
 *
 * - reconnect on close/error - set options.reconnectTimeout=1000
 *      to reconnect after error/close.
 *
 * - handle messages - set options.handler = function(simpleWS, data) {...}
 *
 * - optional keepalive - set options.keepalive = {
 *          create: function(simpleWS) { can return promise },
 *          accept: function(simpleWS, data) { can return promise },
 *          delay: 10000
 *      }
 *
 * - optional handshake on open - set options.handshake = {
 *          create: function(simpleWS) { can return promise }
 *          accept: function(simpleWS, data) { can return promise }
 *      }
 *
 */
function SimpleWS(options) {
    this._options = options || {};
    this._name = options.name || '';
    this._ws = null;
    this._state = STATE_INIT;
    // init with ws if provided
    process.nextTick(this._init.bind(this, options.ws));
}

/**
 * public send() function

 */
SimpleWS.prototype.send = function(data) {
    var self = this;
    return P.fcall(function() {
        if (self._state !== STATE_READY) {
            dbg.warn('WS NOT READY', self._name, self._state);
            throw new Error('WS NOT READY');
        }
        return self._sendData(data);
    });
};

/**
 *
 */
SimpleWS.prototype.close = function() {
    this._ws.close();
};

/**
 *
 */
SimpleWS.prototype._sendData = function(data) {

    // convert data to ArrayBuffer or JSON string
    if (Buffer.isBuffer(data)) {
        data = buffer_utils.toArrayBuffer(data);
    } else if (!(data instanceof ArrayBuffer)) {
        data = JSON.stringify(data);
    }

    // exceptions from send should call the socket's error handler
    dbg.log('WS SEND', this._name, data);
    this._ws.send(data);
};

/**
 * reset the socket and reopen if address is configured
 */
SimpleWS.prototype._reset = function() {
    this._ws = null;
    clearTimeout(this._keepalive_timeout);
    this._keepalive_timeout = null;

    // address should be provided for reconnect
    if (!this._options.address) {

        // if no address is configured we just close
        this._state = STATE_CLOSED;
    } else {

        // call init but not immediate to avoid tight error loops
        this._state = STATE_INIT;
        this._init_timeout = this._init_timeout ||
            setTimeout(this._init.bind(this), 1000);
    }
};

/**
 *
 */
SimpleWS.prototype._init = function(ws) {
    clearTimeout(this._init_timeout);
    this._init_timeout = null;

    if (!ws) {

        // when no ws supplied use address to open new socket
        ws = new WS(this._options.address);
        ws.onopen = this._onWsOpen.bind(this, ws);
    } else {

        // use supplied ws as if it was just opened
        // this path is useful for SimpleWSServer where the socket
        // was already opened and only require to init.
        process.nextTick(this._onWsOpen.bind(this, ws));
    }
    ws.onerror = this._onWsError.bind(this, ws);
    ws.onclose = this._onWsClose.bind(this, ws);
    ws.onmessage = this._onWsMessage.bind(this, ws);

    // keep as current socket
    this._ws = ws;
};

/**
 *
 */
SimpleWS.prototype._onWsOpen = function(ws) {
    if (this._ws !== ws) {
        dbg.log('IGNORE OLD WS OPENED');
        ws.close();
        return;
    }
    this._triggerKeepalive();
    if (this._options.handshake) {
        this._sendHandshake();
    } else {
        dbg.log0('WS READY', this._name);
        this._state = STATE_READY;
    }
};

/**
 *
 */
SimpleWS.prototype._sendHandshake = function() {
    var self = this;
    dbg.log0('WS HANDSHAKE', self._name);
    var createFunc = self._options.handshake && self._options.handshake.create || noop;
    P.fcall(createFunc, self)
        .then(function(data) {
            self._state = STATE_HANDSHAKE;
            self._sendData({
                op: OP_HANDSHAKE,
                data: data
            });
        }, function(err) {
            dbg.error('WS HANDSHAKE CREATE ERROR', self._name);
            self._onWsError(self._ws, err);
        });
};

/**
 *
 */
SimpleWS.prototype._acceptHandshake = function(msg) {
    var self = this;
    if (self._state === STATE_HANDSHAKE) {
        dbg.error('WS HANDSHAKE ON BAD STATE', self._name, self._state);
        self._onWsError(msg._ws, new Error('WS HANDSHAKE ON BAD STATE'));
        return;
    }
    dbg.log0('WS HANDSHAKE ACCEPT', self._name);
    var acceptFunc = self._options.handshake && self._options.handshake.accept || noop;
    P.fcall(acceptFunc, self, msg.data)
        .then(function() {
            self._state = STATE_READY;
        }, function(err) {
            dbg.error('WS HANDSHAKE ACCEPT ERROR', self._name);
            self._onWsError(msg._ws, err);
        });
};

/**
 *
 */
SimpleWS.prototype._triggerKeepalive = function() {
    if (this._options.keepalive && this._options.keepalive.create && !this._keepalive_timeout) {
        this._keepalive_timeout = setTimeout(
            this._sendKeepalive.bind(this),
            this._options.keepalive.delay || 10000);
    }
};

/**
 *
 */
SimpleWS.prototype._sendKeepalive = function() {
    var self = this;
    dbg.log('WS KEEPALIVE', self._name);
    var createFunc = self._options.keepalive.create || noop;
    P.fcall(createFunc, self)
        .then(function(data) {
            clearTimeout(self._keepalive_timeout);
            self._keepalive_timeout = null;
            self._sendData({
                op: OP_KEEPALIVE,
                data: data
            });
            self._triggerKeepalive();
        }, function(err) {
            dbg.error('WS KEEPALIVE CREATE ERROR', self._name);
            self._onWsError(self._ws, err);
        });
};

/**
 *
 */
SimpleWS.prototype._acceptKeepalive = function(msg) {
    var self = this;
    if (self._state !== STATE_READY && self._state !== STATE_HANDSHAKE) {
        dbg.error('WS KEEPALIVE ON BAD STATE', self._name, self._state);
        self._onWsError(msg._ws, new Error('WS MESSAGE ON BAD STATE'));
        return;
    }
    dbg.log0('WS KEEPALIVE ACCEPT', self._name);
    var acceptFunc = self._options.keepalive && self._options.keepalive.accept || noop;
    P.fcall(acceptFunc, self, msg.data)
        .then(null, function(err) {
            dbg.error('WS HANDSHAKE ACCEPT ERROR', self._name);
            self._onWsError(msg._ws, err);
        });

};

/**
 *
 */
SimpleWS.prototype._acceptMessage = function(msg) {
    var self = this;
    if (self._state !== STATE_READY) {
        dbg.error('WS MESSAGE ON BAD STATE', self._name, self._state);
        self._onWsError(msg._ws, new Error('WS MESSAGE ON BAD STATE'));
        return;
    }
    dbg.log0('WS MESSAGE', this._name, msg.data);
    var handlerFunc = self._options.handler || noop;
    P.fcall(handlerFunc, self, msg.data)
        .then(null, function(err) {
            dbg.error('WS MESSAGE HANDLER ERROR', self._name);
            self._onWsError(msg._ws, err);
        });
};

/**
 *
 */
SimpleWS.prototype._onWsMessage = function(ws, event) {
    if (this._ws !== ws) {
        dbg.log('IGNORE OLD WS MESSAGE', this._name);
        ws.close();
        return;
    }

    var msg;
    if (event.binary) {
        msg = {
            op: OP_MESSAGE,
            data: buffer_utils.toBuffer(event.data)
        };
    } else {
        try {
            msg = JSON.parse(event.data);
        } catch (err) {
            dbg.error('WS JSON PARSE ERROR', this._name, event.data);
            this._onWsError(ws, err);
            return;
        }
    }

    msg._ws = ws;

    switch (msg.op) {
        case OP_KEEPALIVE:
            this._acceptKeepalive(msg);
            break;
        case OP_HANDSHAKE:
            this._acceptHandshake(msg);
            break;
        case OP_MESSAGE:
            this._acceptMessage(msg);
            break;
        default:
            dbg.error('WS MESSAGE BAD OP', this._name, msg);
            this._onWsError(ws, new Error('WS MESSAGE BAD OP'));
            break;
    }
};

/**
 *
 */
SimpleWS.prototype._onWsError = function(ws, err) {
    dbg.error('WS ERROR', this._name, err.stack || err);
    ws.close();
    if (this._ws === ws) {
        this._reset();
    }
};

/**
 *
 */
SimpleWS.prototype._onWsClose = function(ws) {
    if (this._ws !== ws) {
        dbg.log('OLD WS CLOSED', this._name);
        return;
    }
    dbg.error('WS CLOSED', this._name);
    this._reset();
};


/**
 * export the server class
 */
SimpleWS.Server = SimpleWSServer;

/**
 * TODO document options
 */
function SimpleWSServer(options) {
    this._options = options || {};
    this._wss = new WS.Server(options.server);
    this._wss.on('connection', this._onConnection.bind(this));
    this._wss.on('error', this._onError.bind(this));
}

SimpleWSServer.prototype._onConnection = function(ws) {
    var self = this;

    // initialize a SimpleWS to handle this socket
    var simpleWS = new SimpleWS({
        keepalive: self._options.keepalive,
        handshake: self._options.handshake,
        handler: self._options.handler,
        ws: ws
    });

    // notify on new connection if connHandler was provided
    var connHandlerFunc = self._options.connHandler || noop;
    P.fcall(connHandlerFunc, simpleWS)
        .then(null, function(err) {
            dbg.log('WS SERVER CONNECTION HANDLER ERROR', err.stack || err);
            simpleWS.close();
        });
};

SimpleWSServer.prototype._onError = function(err) {
    dbg.error('WS SERVER ERROR', err.stack || err);
};


function noop() {}
