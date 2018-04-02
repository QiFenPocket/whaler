'use strict';

const fs = require('fs/promises');
const path = require('path');
const yaml = require('js-yaml');
const util = require('dockerode/lib/util');
const parseEnv = require('../../lib/parse-env');
const renderTemplate = require('../../lib/render-template');

module.exports = exports;
module.exports.__cmd = require('./cmd');

/**
 * @param whaler
 */
async function exports (whaler) {

    whaler.on('config', async ctx => {
        const { default: storage } = await whaler.fetch('apps');
        const app = await storage.get(ctx.options['name']);

        const update = {};
        if (ctx.options['setEnv']) {
            app.env = update['env'] = ctx.options['setEnv'];
        }
        if (ctx.options['update']) {
            update['config'] = await loadConfig(app, ctx.options);
        }

        if (Object.keys(update).length > 0) {
            await storage.update(ctx.options['name'], update);
            ctx.result = update['config'] || app.config;

        } else {
            let config = app.config;
            if (ctx.options['file']) {
                config = await loadConfig(app, ctx.options);
            }
            ctx.result = config;
        }
    });

    const loadConfig = async (app, options) => {
        let data;
        const vars = await prepareVars(app, options);
        const file = options['file'] || app.config['file'] || app.path + '/whaler.yml';

        // deprecated
        if (options['yml']) {
            const tmpFile = file + '.tmp';
            await fs.writeFile(tmpFile, options['yml'], 'utf8');
            data = await renderTemplate(tmpFile, vars);
            await fs.unlink(tmpFile);

        } else {
            if (!path.isAbsolute(file)) {
                throw new Error('Config path must be absolute.');
            }

            try {
                await fs.stat(file);
            } catch (e) {
                throw new Error('Config file "' + file + '" not exists.');
            }

            data = await renderTemplate(file, vars);
        }

        // data = data.replace('[app_name]', options['name']);
        // data = data.replace('[app_path]', app.path);
        data = yaml.load(data);

        return {
            file: file,
            data: await prepareConfig(data, app.env, (opts) => loadConfig(app, opts))
        };
    };

    const prepareVars = async (app, options) => {
        const vars = await whaler.emit('vars');

        try {
            const content = await fs.readFile(app.path + '/.env', 'utf8');
            const env = parseEnv(content || '');
            for (let key in env) {
                vars[key] = env[key];
            }
        } catch (e) {}

        vars['APP_NAME'] = options['name'];
        vars['APP_PATH'] = app.path;
        vars['APP_ENV'] = app.env;

        return vars;
    };

}

// PRIVATE

/**
 * @param config
 * @param env
 * @returns {Object}
 */
async function prepareConfig (config, env, loader) {
    config = config || {};
    config = prepareConfigEnv(config, env);
    if (config['services'] || null) {
        const scale = {};
        const services = config['services'];
        for (let key in services) {
            if (!/^[a-z0-9-]+$/.test(key)) {
                throw new Error('Service name "' + key + '" includes invalid characters, only "[a-z0-9-]" are allowed.');
            }

            if (services[key]['extends']) {
                const ex = await loader({
                    file: path.resolve(services[key]['extends']['file'])
                });
                const data = ex['data']['services'][services[key]['extends']['service']];
                services[key] = util.extend({}, data, services[key]);
                delete services[key]['extends'];
            }

            if (services[key]['extend']) {
                if ('string' === typeof services[key]['extend']) {
                    let service = services[key]['extend'];
                    let include = undefined;
                    let exclude = undefined;
                    if (service.indexOf('&') !== -1) {
                        const parts = service.split('&');
                        service = parts[0];
                        include = parts[1].split(',');
                    } else if (service.indexOf('!') !== -1) {
                        const parts = service.split('!');
                        service = parts[0];
                        exclude = parts[1].split(',');
                    }

                    services[key]['extend'] = {
                        service: service,
                        include: include,
                        exclude: exclude
                    };
                }

                let data = {};
                if (services[key]['extend']['include']) {
                    for (let include of services[key]['extend']['include']) {
                        if (services[services[key]['extend']['service']].hasOwnProperty(include)) {
                            data[include] = services[services[key]['extend']['service']][include];
                        }
                    }
                } else {
                    data = util.extend({}, services[services[key]['extend']['service']]);
                    if (services[key]['extend']['exclude']) {
                        for (let exclude of services[key]['extend']['exclude']) {
                            if (data.hasOwnProperty(exclude)) {
                                delete data[exclude];
                            }
                        }
                    }
                }

                if (data.hasOwnProperty('ports')) {
                    delete data['ports'];
                }

                services[key] = util.extend({}, data, services[key]);

                delete services[key]['extend'];
            }

            if (services[key]['volumes'] && !Array.isArray(services[key]['volumes'])) {
                const volumes = [];
                for (let v in services[key]['volumes']) {
                    if (services[key]['volumes'][v]) {
                        volumes.push(v + ':' + services[key]['volumes'][v]);
                    } else {
                        volumes.push(v);
                    }
                }
                services[key]['volumes'] = volumes;
            }

            if (services[key]['env'] && !Array.isArray(services[key]['env'])) {
                const env = [];
                for (let e in services[key]['env']) {
                    if (services[key]['env'][e]) {
                        env.push(e + '=' + services[key]['env'][e]);
                    } else {
                        env.push(e);
                    }
                }
                services[key]['env'] = env;
            }

            if (services[key]['wait'] && 'string' !== typeof services[key]['wait']) {
                services[key]['wait'] = services[key]['wait'] + 's';
            }

            // experimental
            if (services[key].hasOwnProperty('scale')) {
                if (services[key]['scale']) {
                    scale[key] = services[key]['scale'];
                }
                delete services[key]['scale'];
            }
        }

        // experimental
        if (Object.keys(scale).length) {
            const newServices = {};
            for (let key in services) {
                if (scale[key] || false) {
                    for (let i = 1; i <= scale[key]; i++) {
                        newServices[key + i] = services[key];
                    }
                } else {
                    newServices[key] = services[key];
                }
            }
            config['services'] = newServices;
        }

    } else {
        config['services'] = {};
    }

    return config;
}

/**
 * @param config
 * @param env
 * @returns {Object}
 */
function prepareConfigEnv (config, env) {
    if ('object' === typeof config && null !== config && Object.keys(config).length) {
        env = env.split(',');
        const keys = Object.keys(config);
        for (let key of keys) {
            if ('~' == key[0]) {
                const parts = key.split('~')[1].split(',');
                for (let e of env) {
                    if (parts.includes(e)) {
                        config = util.extend({}, config, config[key]);
                    }
                }
                delete config[key];
                config = prepareConfigEnv(config, env.join(','));
            } else {
                config[key] = prepareConfigEnv(config[key], env.join(','));
            }
        }
    }

    return config;
}
