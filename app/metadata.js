const _ = require('lodash');
const http = require('http');
const url = require('url');

exports.defaultOptions = {
    path: 'http://169.254.169.254/latest/',
    httpOptions: { timeout: 100 },
    socketTimeout: 100,
    isDirectory: (path, body) => /\/$/.test(path),
    isArray: (path, body) => /s$/.test(path),
};

exports.query = function(options) {
    options = _.assign({}, exports.defaultOptions, options);
    return resolve(options.path, options);
};

async function resolve(path, options) {
    const response = await get(path, options);
    if (response.redirect) return resolve(response.redirect, options);
    if (response.isRateLimited) {
        const interval = (response.interval || 1) * 1000;
        await wait(interval);
        return resolve(path, options);
    }
    if (options.isDirectory(path, response.body)) {
        const childrenPairs = _.compact(response.body.split('\n')).map(str => str.split('=', 2));
        const childrenPaths = childrenPairs.map(pair => pair[0]);
        const childrenNames = childrenPairs.map(pair => (pair[1] || pair[0]).replace(/\/$/, ""));
        const childrenContent = await asyncMap(childrenPaths, childPath => resolve(path + childPath, options));
        return _.zipObject(childrenNames, childrenContent);
    }
    try {
        return JSON.parse(response.body);
    } catch (e) {
        if (options.isArray(path, response.body)) {
            return response.body.split('\n');
        } else {
            return response.body;
        }
    }
}

function get(path, options) {
    return new Promise((resolve, reject) => {
        const httpOptions = _.assign({}, options.httpOptions, url.parse(path));
        const request = http.get(httpOptions, response => {
            if (response.statusCode == 429) {
                resolve({ isRateLimited: true, interval: parseInt(response.headers['retry-after'], 10) });
                return;
            }
            if (response.statusCode == 301 || response.statusCode == 302) {
                resolve({ redirect: response.headers.location });
                return;
            }
            if (response.statusCode != 200) {
                reject(new Error('http request failed, status: ' + response.statusCode + ', url: ' + path));
                return;
            }
            const body = [];
            response.on('data', chunk => body.push(chunk));
            response.on('end', () => resolve({ body: body.join('') }));
            response.on('error', err => reject(err));
        });
        request.on('error', err => reject(err));
        request.on('socket', socket => {
            socket.setTimeout(options.socketTimeout);
            socket.on('timeout', () => request.abort());
        });
    });
}

function wait(interval) {
   return new Promise(resolve => setTimeout(resolve, interval));
}

async function asyncMap(array, projection) {
    var result = [];
    for (var i = 0; i < array.length; i++) {
        result.push(await projection(array[i], i, array));
    }
    return result;
}