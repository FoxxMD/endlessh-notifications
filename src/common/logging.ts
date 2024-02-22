import path from "path";
import {configDir} from "./index.js";
import * as winstonNs from '@foxxmd/winston';
import winstonDef, {config, level, verbose} from '@foxxmd/winston';
import {asLogOptions, LogConfig, LogInfo, LogInfoMeta, LogLevel, LogOptions} from "./infrastructure/Atomic.js";
import process from "process";
import {ErrorWithCause, stackWithCauses} from "pony-cause";
import {NullTransport} from 'winston-null';
import DailyRotateFile from 'winston-daily-rotate-file';
import dayjs from "dayjs";
import stringify from 'safe-stable-stringify';
import {SPLAT, LEVEL, MESSAGE} from 'triple-beam';
import {fileOrDirectoryIsWriteable} from "../utils/io.js";
import {capitalize, mergeArr} from "../utils/index.js";
import {format} from 'logform';
import {LabelledLogger} from "./infrastructure/Logging.js";
import {
    pino,
    TransportTargetOptions,
    Level, StreamEntry,
} from 'pino';
import pRoll from 'pino-roll';
import prettyDef, {PrettyOptions, PinoPretty, colorizerFactory} from 'pino-pretty';
import {createColors} from 'colorette';
import * as Colorette from "colorette";

const {combine, printf, timestamp, label, splat, errors} = format;

//const {transports} = winstonNew;
const {loggers, transports} = winstonDef;

export let logPath = path.resolve(configDir, `./logs`);
if (typeof process.env.CONFIG_DIR === 'string') {
    logPath = path.resolve(process.env.CONFIG_DIR, './logs');
}

if(!loggers.has('noop')) {
    loggers.add('noop', {transports: [new NullTransport()]});
}

export type AppLogger = WinstonLogger | LabelledLogger;

export const getLogger = (config: LogConfig = {}, name = 'App'): WinstonLogger => {

    if (!loggers.has(name)) {
        const errors: (Error | string)[] = [];

        let options: LogOptions = {};
        if (asLogOptions(config)) {
            options = config;
        } else {
            errors.push(`Logging levels were not valid. Must be one of: 'error', 'warn', 'info', 'verbose', 'debug' -- 'file' may be false.`);
        }

        const {level: configLevel} = options;
        const defaultLevel = process.env.LOG_LEVEL || 'info';
        const {
            level = configLevel || defaultLevel,
            file = configLevel || defaultLevel,
            console = configLevel || 'debug'
        } = options;

        const consoleTransport = new transports.Console({level: console});

        const myTransports = [
            consoleTransport,
        ];

        if (file !== false) {
            const rotateTransport = new DailyRotateFile({
                dirname: logPath,
                createSymlink: true,
                symlinkName: 'app-current.log',
                filename: 'app-%DATE%.log',
                datePattern: 'YYYY-MM-DD',
                maxSize: '5m',
                level: file
            });

            try {
                fileOrDirectoryIsWriteable(logPath);
                // @ts-ignore
                myTransports.push(rotateTransport);
            } catch (e: any) {
                const msg = 'WILL NOT write logs to rotating file due to an error while trying to access the specified logging directory';
                errors.push(new ErrorWithCause<Error>(msg, {cause: e as Error}));
            }
        }

        const loggerOptions: winstonNs.LoggerOptions = {
            level: level,
            format: labelledFormat(name),
            transports: myTransports,
            levels: logLevels
        };

        loggers.add(name, loggerOptions);

        const logger = loggers.get(name);
        if (errors.length > 0) {
            for (const e of errors) {
                logger.error(e);
            }
        }
        return logger as WinstonLogger;
    }
    return loggers.get(name) as WinstonLogger;
}

const breakSymbol = '<br />';
export const formatLogToHtml = (chunk: Buffer) => {
    const line = chunk.toString().replace('\n', breakSymbol)
        .replace(/(debug)\s/gi, '<span class="debug blue">$1 </span>')
        .replace(/(warn)\s/gi, '<span class="warn yellow">$1 </span>')
        .replace(/(info)\s/gi, '<span class="info green">$1 </span>')
        .replace(/(verbose)\s/gi, '<span class="verbose purple">$1 </span>')
        .replace(/(error)\s/gi, '<span class="error red">$1 </span>')
        .trim();
    if(line.slice(-6) !== breakSymbol) {
        return `${line}${breakSymbol}`;
    }
    return line;
}

const levelSymbol = Symbol.for('level');
const s = splat();
//const errorsFormat = errors({stack: true});
const CWD = process.cwd();

const causeKeys = ['name',  'cause']

export const defaultFormat = (defaultLabel = 'App') => printf(({
                                                                   label,
                                                                   [levelSymbol]: levelSym,
                                                                   level,
                                                                   message,
                                                                   labels = [defaultLabel],
                                                                   leaf,
                                                                   timestamp,
                                                                   durationMs,
                                                                   [SPLAT]: splatObj,
                                                                   stack,
                                                                   sendToGuild,
                                                                   discordGuild,
                                                                   guild,
                                                                   byDiscordUser,
                                                                   channel,
                                                                   discordMessage,
                                                                   toChannel,
                                                                   ...rest
                                                               }) => {
    const keys = Object.keys(rest);
    const stringifyValue = keys.length > 0 && !keys.every(x => causeKeys.some(y => y == x)) ? stringify(rest) : '';
    let msg = message;
    let stackMsg = '';
    if (stack !== undefined) {
        const stackArr = stack.split('\n');
        const stackTop = stackArr[0];
        const cleanedStack = stackArr
            .slice(1) // don't need actual error message since we are showing it as msg
            .map((x: string) => x.replace(CWD, 'CWD')) // replace file location up to cwd for user privacy
            .join('\n'); // rejoin with newline to preserve formatting
        stackMsg = `\n${cleanedStack}`;
        if (msg === undefined || msg === null || typeof message === 'object') {
            msg = stackTop;
        } else {
            stackMsg = `\n${stackTop}${stackMsg}`
        }
    }

    const nodes = Array.isArray(labels) ? labels : [labels];
    if (leaf !== null && leaf !== undefined && !nodes.includes(leaf)) {
        nodes.push(leaf);
    }
    const labelContent = `${nodes.map((x: string) => `[${x}]`).join(' ')}`;

    return `${timestamp} ${level.padEnd(8)}: ${labelContent} ${msg}${stringifyValue !== '' ? ` ${stringifyValue}` : ''}${stackMsg}`;
});

export const labelledFormat = (labelName = 'App') => {
    const l = label({label: capitalize(labelName), message: false});
    return combine(
        timestamp(
            {
                format: () => dayjs().local().format(),
            }
        ),
        l,
        s,
        errorAwareFormat,
        defaultFormat(capitalize(labelName)),
    );
}

export const logLevels = {
    error: 0,
    warn: 1,
    safety: 2,
    info: 2,
    http: 3,
    verbose: 4,
    debug: 5,
    trace: 5,
    silly: 6
};

export const LOG_LEVEL_REGEX = /\s*(debug|warn|info|error|verbose)\s*:/i
export const isLogLineMinLevel = (log: string | LogInfo, minLevelText: LogLevel): boolean => {
    // @ts-ignore
    const minLevel = logLevels[minLevelText];
    let level: number;

    if(typeof log === 'string') {
        const lineLevelMatch =  log.match(LOG_LEVEL_REGEX)
        if (lineLevelMatch === null) {
            return false;
        }
        // @ts-ignore
        level = logLevels[lineLevelMatch[1]];
    } else {
        const lineLevelMatch = log.level;
        // @ts-ignore
        level = logLevels[lineLevelMatch];
    }
    return level <= minLevel;
}

const isProbablyError = (val: any, explicitErrorName?: string) => {
    if(typeof val !== 'object' || val === null) {
        return false;
    }
    const {name, stack} = val;
    if(explicitErrorName !== undefined) {
        if(name !== undefined && name.toLowerCase().includes(explicitErrorName)) {
            return true;
        }
        if(stack !== undefined && stack.trim().toLowerCase().indexOf(explicitErrorName.toLowerCase()) === 0) {
            return true;
        }
        return false;
    } else if(stack !== undefined) {
        return true;
    } else if(name !== undefined && name.toLowerCase().includes('error')) {
        return true;
    }

    return false;
}

const errorAwareFormat = {
    transform: (einfo: any, {stack = true}: any = {}) => {

        // because winston logger.child() re-assigns its input to an object ALWAYS the object we recieve here will never actually be of type Error
        const includeStack = stack && (!isProbablyError(einfo, 'simpleerror') && !isProbablyError(einfo.message, 'simpleerror'));

        if (!isProbablyError(einfo.message) && !isProbablyError(einfo)) {
            return einfo;
        }

        let info: any = {};

        if (isProbablyError(einfo)) {
            const tinfo = transformError(einfo);
            info = Object.assign({}, tinfo, {
                // @ts-ignore
                level: einfo.level,
                // @ts-ignore
                [LEVEL]: einfo[LEVEL] || einfo.level,
                message: tinfo.message,
                // @ts-ignore
                [MESSAGE]: tinfo[MESSAGE] || tinfo.message
            });
            if(includeStack) {
                // so we have to create a dummy error and re-assign all error properties from our info object to it so we can get a proper stack trace
                const dummyErr = new ErrorWithCause('');
                const names = Object.getOwnPropertyNames(tinfo);
                for(const k of names) {
                    if(dummyErr.hasOwnProperty(k) || k === 'cause') {
                        // @ts-ignore
                        dummyErr[k] = tinfo[k];
                    }
                }
                // @ts-ignore
                info.stack = stackWithCauses(dummyErr);
            }
        } else {
            const err = transformError(einfo.message);
            info = Object.assign({}, einfo, err);
            // @ts-ignore
            info.message = err.message;
            // @ts-ignore
            info[MESSAGE] = err.message;

            if(includeStack) {
                const dummyErr = new ErrorWithCause('');
                // Error properties are not enumerable
                // https://stackoverflow.com/a/18278145/1469797
                const names = Object.getOwnPropertyNames(err);
                for(const k of names) {
                    if(dummyErr.hasOwnProperty(k) || k === 'cause') {
                        // @ts-ignore
                        dummyErr[k] = err[k];
                    }
                }
                // @ts-ignore
                info.stack = stackWithCauses(dummyErr);
            }
        }

        // remove redundant message from stack and make stack causes easier to read
        if(info.stack !== undefined) {
            let cleanedStack = info.stack.replace(info.message, '');
            cleanedStack = `${cleanedStack}`;
            cleanedStack = cleanedStack.replaceAll('caused by:', '\ncaused by:');
            info.stack = cleanedStack;
        }

        return info;
    }
}

export const transformError = (err: Error): any => _transformError(err, new Set());

const _transformError = (err: Error, seen: Set<Error>) => {
    if (!err || !isProbablyError(err)) {
        return '';
    }
    if (seen.has(err)) {
        return err;
    }

    try {

        // @ts-ignore
        const mOpts = err.matchOptions ?? matchOptions;

        // @ts-ignore
        const cause = err.cause as unknown;

        if (cause !== undefined && cause instanceof Error) {
            // @ts-ignore
            err.cause = _transformError(cause, seen, mOpts);
        }

        return err;
    } catch (e: any) {
        // oops :(
        // we're gonna swallow silently instead of reporting to avoid any infinite nesting and hopefully the original error looks funny enough to provide clues as to what to fix here
        return err;
    }
}

interface LeveledLogMethod {
    (message: string, callback: winstonNs.LogCallback): WinstonLogger;
    (message: string, meta: LogInfoMeta, callback: winstonNs.LogCallback): WinstonLogger;
    (message: string, ...meta: LogInfoMeta[]): WinstonLogger;
    (message: any, meta: LogInfoMeta): WinstonLogger;
    (infoObject: object): WinstonLogger;
}

export interface WinstonLogger extends winstonNs.Logger {
    error: LeveledLogMethod;
    warn: LeveledLogMethod;
    help: LeveledLogMethod;
    data: LeveledLogMethod;
    info: LeveledLogMethod;
    debug: LeveledLogMethod;
    safety: LeveledLogMethod;
    prompt: LeveledLogMethod;
    http: LeveledLogMethod;
    verbose: LeveledLogMethod;
    input: LeveledLogMethod;
    silly: LeveledLogMethod;

    child(options: Object, customzier?: (objValue: any, srcValue: any, key: any, object:any, source:any, stack:any) => any): WinstonLogger;
}

export const pinoLoggers: Map<string, LabelledLogger> = new Map();

const prettyOptsFactory = (opts: PrettyOptions = {}) => {
    const {colorize} = opts;
    const colorizeOpts: undefined | {useColor: boolean} = colorize === undefined ? undefined : {useColor: colorize};
    const colors = createColors(colorizeOpts)

    return {
        ...prettyCommon(colors),
        ...opts
    }
}

const prettyCommon = (colors: Colorette.Colorette): PrettyOptions => {
    return {
        messageFormat: (log, messageKey) => {
            const labels: string[] = log.labels as string[] ?? [];
            const leaf = log.leaf as string | undefined;
            const nodes = labels;
            if (leaf !== null && leaf !== undefined && !nodes.includes(leaf)) {
                nodes.push(leaf);
            }
            const labelContent = nodes.length === 0 ? '' : `${nodes.map((x: string) => colors.blackBright(`[${x}]`)).join(' ')} `;
            const msg = log[messageKey];
            const stackTrace = log.err !== undefined ? `\n${(log.err as any).stack}` : '';
            return `${labelContent}${msg}${stackTrace}`;
        },
        hideObject: false,
        ignore: 'pid,hostname,labels,err',
        translateTime: 'SYS:standard',
        customLevels: {
            verbose: 25,
            log: 21,
        },
        customColors: 'verbose:magenta,log:greenBright',
        colorizeObjects: true,
        // @ts-ignore
        useOnlyCustomProps: false,
    }
}

const prettyConsole: PrettyOptions = prettyOptsFactory()
const prettyFile: PrettyOptions = prettyOptsFactory({
    colorize: false,
});

const buildParsedLogOptions = (config: LogConfig = {}): Required<LogOptions> => {
    if (!asLogOptions(config)) {
        throw new Error(`Logging levels were not valid. Must be one of: 'error', 'warn', 'info', 'verbose', 'debug', 'silent' -- 'file' may be false.`)
    }

    const {level: configLevel} = config;
    const defaultLevel = process.env.LOG_LEVEL || 'info';
    const {
        level = configLevel || defaultLevel,
        file = configLevel || defaultLevel,
        console = configLevel || 'debug'
    } = config;

    return {
        level: level as LogLevel,
        file: file as LogLevel | false,
        console
    };
}

export const getPinoLogger = async (config: LogConfig = {}, name = 'App'): Promise<LabelledLogger> => {

    if(pinoLoggers.has(name)) {
        return pinoLoggers.get(name);
    }

    const errors: (Error | string)[] = [];

    let options: LogOptions = {};
    if (asLogOptions(config)) {
        options = config;
    } else {
        errors.push(`Logging levels were not valid. Must be one of: 'error', 'warn', 'info', 'verbose', 'debug', 'silent' -- 'file' may be false.`);
    }

    const {level: configLevel} = options;
    const defaultLevel = process.env.LOG_LEVEL || 'info';
    const {
        level = configLevel || defaultLevel,
        file = configLevel || defaultLevel,
        console = configLevel || 'debug'
    } = options;

    const streams: StreamEntry[] = [
        {
            level: configLevel as Level,
            stream: prettyDef.default({...prettyConsole, destination: 1, sync: true})
        }
    ]

    if(file !== false) {
        try {
            fileOrDirectoryIsWriteable(logPath);
            const rollingDest = await pRoll({
                file: path.resolve(logPath, 'app'),
                size: 10,
                frequency: 'daily',
                get extension() {return `-${dayjs().format('YYYY-MM-DD')}.log`},// '.log',
                mkdir: true,
                sync: false,
            });

            streams.push({
                level: file as Level,
                stream: prettyDef.default({...prettyFile, destination: rollingDest})
            })
        } catch (e: any) {
            const msg = 'WILL NOT write logs to rotating file due to an error while trying to access the specified logging directory';
            errors.push(new ErrorWithCause<Error>(msg, {cause: e as Error}));
        }
    }

    const plogger = buildPinoLogger(level as Level, streams);
    pinoLoggers.set(name, plogger);
    return plogger;
}

const buildPinoFileStream = async (options: Required<LogOptions>): Promise<StreamEntry | undefined> => {
    const {file} = options;
    if(file === false) {
        return undefined;
    }

    try {
        fileOrDirectoryIsWriteable(logPath);
        const rollingDest = await pRoll({
            file: path.resolve(logPath, 'app'),
            size: 10,
            frequency: 'daily',
            get extension() {return `-${dayjs().format('YYYY-MM-DD')}.log`},// '.log',
            mkdir: true,
            sync: false,
        });

        return {
            level: file as Level,
            stream: prettyDef.default({...prettyFile, destination: rollingDest})
        };
    } catch (e: any) {
        throw new ErrorWithCause<Error>('WILL NOT write logs to rotating file due to an error while trying to access the specified logging directory', {cause: e as Error});
    }
}

const buildPinoConsoleStream = (options: Required<LogOptions>): StreamEntry => {
    return {
        level: options.console as Level,
        stream: prettyDef.default({...prettyConsole, destination: 1, sync: true})
    }
}

const buildPinoLogger = (defaultLevel: Level, streams: StreamEntry[]): LabelledLogger => {
    const plogger = pino({
        // @ts-ignore
        mixin: (obj, num, loggerThis) => {
            return {
                labels: loggerThis.labels ?? []
            }
        },
        level: defaultLevel,
        customLevels: {
            verbose: 25,
            log: 21
        },
        useOnlyCustomLevels: false,
    }, pino.multistream(streams)) as LabelledLogger;

    plogger.addLabel = function (value) {
        if (this.labels === undefined) {
            this.labels = [];
        }
        this.labels.push(value)
    }
    return plogger;
}

export const testPinoLogger = buildPinoLogger(('silent' as Level), [buildPinoConsoleStream(buildParsedLogOptions({level: 'silent'}))]);

export const initPinoLogger = buildPinoLogger(('debug' as Level), [buildPinoConsoleStream(buildParsedLogOptions({level: 'debug'}))]);

export const appPinoLogger = async (config: LogConfig = {}, name = 'App') => {
    const options = buildParsedLogOptions(config);
    const stream = buildPinoConsoleStream(options);
    const file = await buildPinoFileStream(options);
    return buildPinoLogger(options.level as Level, [stream, file]);
}

export const createChildPinoLogger = (parent: LabelledLogger, labelsVal: any | any[] = [], context: object = {}, options = {}) => {
    const newChild = parent.child(context, options) as LabelledLogger;
    const labels = Array.isArray(labelsVal) ? labelsVal : [labelsVal];
    newChild.labels = [...[...(parent.labels ?? [])], ...labels];
    newChild.addLabel = function (value) {
        if(this.labels === undefined) {
            this.labels = [];
        }
        this.labels.push(value);
    }
    return newChild
}

export const createChildWinstonLogger = (logger: WinstonLogger, meta: object): WinstonLogger => {
    return logger.child(meta, mergeArr);
}

export const createChildLogger = (logger: AppLogger, labelsVal: any | any[] = []): AppLogger => {
    const labels = Array.isArray(labelsVal) ? labelsVal : [labelsVal];
    if('bindings' in logger) {
        return createChildPinoLogger(logger as LabelledLogger, labels);
    }
    return createChildWinstonLogger(logger as WinstonLogger, {labels});
}
