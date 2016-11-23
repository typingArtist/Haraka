'use strict';
/*----------------------------------------------------------------------------------------------*/
/* Obtained and modified from http://js.5sh.net/starttls.js on 8/18/2011.                       */
/*----------------------------------------------------------------------------------------------*/

var tls       = require('tls');
var constants = require('constants');
var util      = require('util');
var net       = require('net');
var stream    = require('stream');
var log       = require('./logger');

// provides a common socket for attaching
// and detaching from either main socket, or crypto socket
function pluggableStream(socket) {
    stream.Stream.call(this);
    this.readable = this.writable = true;
    this._timeout = 0;
    this._keepalive = false;
    this._writeState = true;
    this._pending = [];
    this._pendingCallbacks = [];
    if (socket) this.attach(socket);
}

util.inherits(pluggableStream, stream.Stream);

pluggableStream.prototype.pause = function () {
    if (this.targetsocket.pause) {
        this.targetsocket.pause();
        this.readable = false;
    }
};

pluggableStream.prototype.resume = function () {
    if (this.targetsocket.resume) {
        this.readable = true;
        this.targetsocket.resume();
    }
};

pluggableStream.prototype.attach = function (socket) {
    var self = this;
    self.targetsocket = socket;
    self.targetsocket.on('data', function (data) {
        self.emit('data', data);
    });
    self.targetsocket.on('connect', function (a, b) {
        self.emit('connect', a, b);
    });
    self.targetsocket.on('secureConnection', function (a, b) {
        self.emit('secureConnection', a, b);
        self.emit('secure', a, b);
    });
    self.targetsocket.on('secure', function (a, b) {
        self.emit('secureConnection', a, b);
        self.emit('secure', a, b);
    });
    self.targetsocket.on('end', function () {
        self.writable = self.targetsocket.writable;
        self.emit('end');
    });
    self.targetsocket.on('close', function (had_error) {
        self.writable = self.targetsocket.writable;
        self.emit('close', had_error);
    });
    self.targetsocket.on('drain', function () {
        self.emit('drain');
    });
    self.targetsocket.once('error', function (exception) {
        self.writable = self.targetsocket.writable;
        self.emit('error', exception);
    });
    self.targetsocket.on('timeout', function () {
        self.emit('timeout');
    });
    if (self.targetsocket.remotePort) {
        self.remotePort = self.targetsocket.remotePort;
    }
    if (self.targetsocket.remoteAddress) {
        self.remoteAddress = self.targetsocket.remoteAddress;
    }
};

pluggableStream.prototype.clean = function (data) {
    if (this.targetsocket && this.targetsocket.removeAllListeners) {
        this.targetsocket.removeAllListeners('data');
        this.targetsocket.removeAllListeners('secureConnection');
        this.targetsocket.removeAllListeners('secure');
        this.targetsocket.removeAllListeners('end');
        this.targetsocket.removeAllListeners('close');
        this.targetsocket.removeAllListeners('error');
        this.targetsocket.removeAllListeners('drain');
    }
    this.targetsocket = {};
    this.targetsocket.write = function () {};
};

pluggableStream.prototype.write = function (data, encoding, callback) {
    if (this.targetsocket.write) {
        return this.targetsocket.write(data, encoding, callback);
    }
    return false;
};

pluggableStream.prototype.end = function (data, encoding) {
    if (this.targetsocket.end) {
        return this.targetsocket.end(data, encoding);
    }
};

pluggableStream.prototype.destroySoon = function () {
    if (this.targetsocket.destroySoon) {
        return this.targetsocket.destroySoon();
    }
};

pluggableStream.prototype.destroy = function () {
    if (this.targetsocket.destroy) {
        return this.targetsocket.destroy();
    }
};

pluggableStream.prototype.setKeepAlive = function (bool) {
    this._keepalive = bool;
    return this.targetsocket.setKeepAlive(bool);
};

pluggableStream.prototype.setNoDelay = function (/* true||false */) {
};

pluggableStream.prototype.setTimeout = function (timeout) {
    this._timeout = timeout;
    return this.targetsocket.setTimeout(timeout);
};

function pipe(cleartext, socket) {
    cleartext.socket = socket;

    function onerror(e) {
        if (cleartext._controlReleased) {
            cleartext.emit('error', e);
        }
    }

    function onclose() {
        socket.removeListener('error', onerror);
        socket.removeListener('close', onclose);
    }

    socket.on('error', onerror);
    socket.on('close', onclose);
}

function createServer(cb) {
    var serv = net.createServer(function (cryptoSocket) {

        var socket = new pluggableStream(cryptoSocket);

        socket.upgrade = function (options, cb2) {
            log.logdebug('Upgrading to TLS with options=' + util.inspect(options));

            socket.clean();
            cryptoSocket.removeAllListeners('data');

            var cleartext = new tls.TLSSocket(cryptoSocket, options);

            pipe(cleartext, cryptoSocket);

            cleartext.on('error', function(exception) {
                socket.emit('error', exception);
            });

            cleartext.on('secure', function() {
                log.logdebug('TLS secured.');
                var cert = cleartext.getPeerCertificate();
                if (cleartext.getCipher) {
                    var cipher = cleartext.getCipher();
                }
                socket.emit('secure');
                if (cb2) cb2(cleartext.authorized,
                    cleartext.authorizationError, cert, cipher);
            });

//            cleartext._controlReleased = true;

            socket.cleartext = cleartext;

            if (socket._timeout) {
                cleartext.setTimeout(socket._timeout);
            }

            cleartext.setKeepAlive(socket._keepalive);

            socket.attach(socket.cleartext);
        };

        cb(socket);
    });

    return serv;
}

function connect (port, host, cb) {
    var conn_options = {};
    if (typeof port === 'object') {
        conn_options = port;
        cb = host;
    }
    else {
        conn_options.port = port;
        conn_options.host = host;
    }

    var cryptoSocket = net.connect(conn_options);

    var socket = new pluggableStream(cryptoSocket);

    socket.upgrade = function (options, cb2) {
        socket.clean();
        cryptoSocket.removeAllListeners('data');

        // Set SSL_OP_ALL for maximum compatibility with broken servers
        // See http://www.openssl.org/docs/ssl/SSL_CTX_set_options.html
        if (!options) options = {};
        // TODO: bug in Node means we can't do this until it's fixed
        // options.secureOptions = constants.SSL_OP_ALL;

        // See comments around similar code in createServer above for what's
        // going on here.
        options.secureProtocol = options.secureProtocol || 'SSLv23_method';
        options.secureOptions = options.secureOptions |
                    constants.SSL_OP_NO_SSLv2 | constants.SSL_OP_NO_SSLv3;

        if (options) {
            if (options.requestCert === undefined) {
                options.requestCert = true;
            }
            if (options.rejectUnauthorized === undefined) {
                options.rejectUnauthorized = false;
            }
        }
        options.sslcontext = tls.createSecureContext(options);
        options.socket = cryptoSocket;

        var cleartext = new tls.connect(options);

        pipe(cleartext, cryptoSocket);

        cleartext.on('error', function(err) {
            if (err.reason) {
                log.logerror("client TLS error: " + err);
            }
        });

        cleartext.on('secureConnect', function() {
            log.logdebug('client TLS secured.');
            var cert = cleartext.getPeerCertificate();
            if (cleartext.getCipher) {
                var cipher = cleartext.getCipher();
            }
            if (cb2) cb2(cleartext.authorized, cleartext.authorizationError, cert, cipher);
        });

//        cleartext._controlReleased = true;
        socket.cleartext = cleartext;

        if (socket._timeout) {
            cleartext.setTimeout(socket._timeout);
        }

        cleartext.setKeepAlive(socket._keepalive);

        socket.attach(socket.cleartext);

        log.logdebug('client TLS upgrade in progress, awaiting secured.');
    };

    return (socket);
}

exports.connect = connect;
exports.createConnection = connect;
exports.Server = createServer;
exports.createServer = createServer;
