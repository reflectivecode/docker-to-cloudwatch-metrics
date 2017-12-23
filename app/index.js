const yaml = require('js-yaml');
const fs = require('fs');
const Docker = require('dockerode');
const _ = require('lodash');
const AWS = require('aws-sdk');
const { VM, VMScript } = require('vm2');

const file = process.argv[2];
console.log(`Opening config file ${file}`)
const config = deepCompile(yaml.safeLoad(fs.readFileSync(file, 'utf8')));

const cloudwatch = new AWS.CloudWatch();
const docker = new Docker();
const metadata = {};
const configVm = new VM({
    sandbox: {
        env: process.env,
        metadata: metadata
    }
});

main();

async function main() {
    await applyMetadata();
    let variables = {};
    while (true) {
        const start = Date.now();
        try {
            variables = await monitorAllContainers(variables);
        } catch (err) {
            console.error(err);
        }
        const interval = vmEval(configVm, config.interval, 'interval') || 0 * 1000;
        await waitUntil(start + interval);
    }
}

async function applyMetadata() {
    _.assign(metadata, await getMetadata());

    if (!cloudwatch.config.region && metadata.dynamic) {
        const region = metadata.dynamic['instance-identity'].document.region
        console.log(`aws-sdk region is not set - using region ${region} from metadata endpoint`);
        cloudwatch.config.update({ region: region });
    }
}

function getMetadata() {
    const instance = require("ec2-instance-data");
    return new Promise(resolve => {
        instance.init(err => {
            if (err) {
                console.error("Error fetching EC2 metadata");
                console.error(err);
                resolve({});
            } else {
                resolve(instance.latest);
            };
        });
    });
}

async function waitUntil(time) {
    const timeRemaining = time - Date.now()
    if (timeRemaining > 0) await new Promise(resolve => setTimeout(resolve, timeRemaining));
}

function deepCompile(value) {
    if (_.isString(value)) {
        return new VMScript(value);
    }
    if (_.isArray(value)) {
        return value.map(deepCompile);
    }
    if (_.isPlainObject(value)) {
        return _.mapValues(value, deepCompile);
    }
    return value;
}

async function monitorAllContainers(oldVariables) {
    const listParamerters = vmEval(configVm, config.dockerParameters.list, 'dockerParameters.list');
    const containers = await docker.listContainers(listParamerters);
    console.log(`Found ${containers.length} containers: ${JSON.stringify(containers.map(x => x.Names[0].substring(1)))}`);
    const newVariables = await Promise.all(containers.map(container => getMetricsForContainer(container, oldVariables)));
    return _.fromPairs(_.compact(newVariables));
}

async function getMetricsForContainer(containerInfo, oldVariables) {
    try {
        const container = docker.getContainer(containerInfo.Id);
        const inspectParamerters = vmEval(configVm, config.dockerParameters.inspect, 'dockerParameters.inspect');
        const statsParamerters = vmEval(configVm, config.dockerParameters.stats, 'dockerParameters.stats');
        let [inspect, stats] = await Promise.all([
            container.inspect(inspectParamerters),
            container.stats(_.assign({}, statsParamerters, { stream: false }))
        ]);
        if (!stats || stats.read.indexOf("0001-01-01T") == 0) stats = undefined;
        const variables = {};
        const prevVariables = oldVariables[containerInfo.Id];
        const sandbox = {
            env: process.env,
            metadata: metadata,
            variables: variables,
            prevVariables: prevVariables,
            inspect: inspect,
            stats: stats,
        };
        const vm = new VM({
            sandbox: sandbox
        });
        const context = {
            variables: variables,
            prevVariables: prevVariables,
            inspect: inspect,
            stats: stats,
            sandbox: sandbox,
            vm: vm,
            name: containerInfo.Names[0].substring(1)
        };
        evaluateAllVariables(context);
        const metrics = evaluateAllMetrics(context);
        console.log(`sending ${metrics.length}\tmetrics for ${context.name}`)
        await sendMetrics(metrics);
        return [containerInfo.Id, variables];
    } catch (err) {
        console.error(`Error getting info for container ${containerInfo.Names[0].substring(1)} ${containerInfo.Id}`);
        console.error(err);
    }
}

function evaluateAllVariables(context) {
    config.metricSets.forEach((metricSet, index) => {
        if (!metricSet.variables) return [];
        if (metricSet.requires && metricSet.requires.stats && !context.stats) return [];
        if (metricSet.requires && metricSet.requires.prevVariables && !context.prevVariables) return [];
        _.forEach(metricSet.variables, (value, key) => {
            try {
                context.variables[key] = vmEval(context.vm, value, `metricSets[${index}].variables.${key}`);
            } catch (err) {
                console.error(err);
            }
        });
    });
}

function evaluateAllMetrics(context) {
    return _.flatten(config.metricSets.map((metricSet, index) => {
        if (!metricSet.metrics || !metricSet.metrics.length) return [];
        if (metricSet.requires && metricSet.requires.stats && !context.stats) return [];
        if (metricSet.requires && metricSet.requires.prevVariables && !context.prevVariables) return [];
        try {
            const defaults = metricSet.metricDefaults ? vmEval(context.vm, metricSet.metricDefaults, `metricSets[${index}].metricDefaults`) : {};
            return _.compact(metricSet.metrics.map((metric, metricIndex) => {
                try {
                    return _.assign({}, defaults, vmEval(context.vm, metric, `metricSets[${index}].metrics[${metricIndex}]`));
                } catch (err) {
                    console.error(err);
                }
            }));
        } catch (err) {
            console.error(err);
            return [];
        }
    }));
}

function vmEval(vm, value, path) {
    try {
        if (_.isString(value) || value instanceof VMScript) {
            return vm.run(value);
        }
        if (_.isBoolean(value) || _.isNumber(value) || _.isNull(value) || _.isUndefined(value)) {
            return value;
        }
        if (_.isArray(value)) {
            return value.map((item, index) => vmEval(vm, item, `${path}[${index}]`));
        }
        if (_.isPlainObject(value)) {
            return _.mapValues(value, (item, key) => vmEval(vm, item, `${path}.${key}`));
        }
        throw new Error(`Unexpected value. Only string, boolean, number, null, undefined, array, plain object, and VMScript supported.`);
    } catch (err) {
        console.error(`Error evaluating ${path} with value ${JSON.stringify(value, (k, v) => v instanceof VMScript ? v.code : v)}`);
        console.log("context:", JSON.stringify(vm.options.sandbox, null, 2));
        throw err;
    }
}

async function sendMetrics(metrics) {
    return Promise.all(_(metrics).groupBy('Namespace')
                                 .mapValues(metrics => metrics.map(metric => _.omit(metric, 'Namespace')))
                                 .map((metrics, namespace) => cloudwatch.putMetricData({ Namespace: namespace, MetricData: metrics }).promise())
                                 .value());
}