import dns from 'dns';
import async from 'async';
import { Entity, IntegrationContext as Context, Error, Logger } from 'polarity-integration-utils';
import { promisify } from 'util';
import {
  DnsAnswer,
  DnsAnswerDomain,
  DnsAnswerIP,
  DnsResult,
  Options,
  DomainRecordType,
  DnsError,
  LookupResult as Result
} from './types';
const resolve = promisify(dns.resolve);
const resolve4 = promisify(dns.resolve4);
const resolve6 = promisify(dns.resolve6);
const reverse = promisify(dns.reverse);

/**
 * Helper function to safely access domain answer records with proper typing
 */
function getDomainRecord(answers: DnsAnswerDomain, recordType: DomainRecordType): DnsResult {
  return answers[recordType];
}

const MAX_TASKS_AT_A_TIME = 5;
const MAX_ENTITIES_AT_A_TIME = 2;

let previousDns: string;

const DNS_ERRORS = {
  ENODATA: 'DNS server returned an answer with no data.',
  EFORMERR: 'DNS server claims query was misformatted.',
  ESERVFAIL: 'DNS server returned general failure.',
  ENOTFOUND: 'Domain name not found.',
  ENOTIMP: 'DNS server does not implement the requested operation.',
  EREFUSED: 'DNS server refused query.',
  EBADQUERY: 'Misformatted DNS query.',
  EBADNAME: 'Misformatted host name.',
  EBADFAMILY: 'Unsupported address family.',
  EBADRESP: 'Misformatted DNS reply.',
  ECONNREFUSED: 'Could not contact DNS servers.',
  ETIMEOUT: 'Timeout while contacting DNS servers.',
  EEOF: 'End of file.',
  EFILE: 'Error reading file.',
  ENOMEM: 'Out of memory.',
  EDESTRUCTION: 'Channel is being destroyed.',
  EBADSTR: 'Misformatted string.',
  EBADFLAGS: 'Illegal flags specified.',
  ENONAME: 'Given host name is not numeric.',
  EBADHINTS: 'Illegal hints flags specified.',
  ENOTINITIALIZED: 'c-ares library initialization not yet performed.',
  ELOADIPHLPAPI: 'Error loading iphlpapi.dll.',
  EADDRGETNETWORKPARAMS: 'Could not find GetNetworkParams function.',
  ECANCELLED: 'DNS query cancelled.'
};

function startup(logger: Logger) {
  logger.info('Starting up DNS Query Integration');
  return logger;
}

/**
 * Creates an empty answer response object.  We use this object format to make it easier to display the data in our template.
 */
function getBlankAnswer(entity: Entity): DnsAnswer {
  // IP Addresses can only do reverse DNS lookups which is of type PTR
  if (entity.isIP) {
    return {
      PTR: {
        results: [],
        error: null,
        searched: true
      }, // since objects do not have a defined order to the keys, this array is used to
      // access the answer objects in the correct order.  We sort this so that answers
      // with data come first.
      __order: ['PTR']
    };
  }

  return {
    A: {
      results: [],
      error: null,
      searched: false
    },
    AAAA: {
      results: [],
      error: null,
      searched: false
    },
    CNAME: {
      results: [],
      error: null,
      searched: false
    },
    MX: {
      results: [],
      error: null,
      searched: false
    },
    TXT: {
      results: [],
      error: null,
      searched: false
    },
    NS: {
      results: [],
      error: null,
      searched: false
    },
    SOA: {
      results: [],
      error: null,
      searched: false
    }, // since objects do not have a defined order to the keys, this array is used to
    // access the answer objects in the correct order.  We sort this so that answers
    // with data come first.
    __order: ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA']
  };
}

const parseErrorToReadableJson = (error: Error) => JSON.parse(JSON.stringify(error, Object.getOwnPropertyNames(error)));

async function doLookup(entities: Entity[], options: Options, context: Context): Promise<Result[]> {
  const { logger } = context;
  logger.trace({ entities, options }, 'doLookup');
  let lookupResults: Result[] = [];

  if (options.dns.length > 0 && previousDns !== options.dns) {
    logger.trace({ dnsServer: options.dns }, 'Setting DNS Server');
    dns.setServers([options.dns]);
    previousDns = options.dns;
  }

  try {
    await async.eachLimit(entities, MAX_ENTITIES_AT_A_TIME, async (entity) => {
      // If the private IP only option is set ignore non-private IP addresses
      if (options.privateIpOnly && entity.isIP && !entity.isPrivateIP) {
        logger.trace('Ignore non-private IP ' + entity.value);
        return;
      }

      let answers = getBlankAnswer(entity);
      let totalAnswers = 0;
      const tasks = [];

      if (entity.isIP) {
        const ipAnswers = answers as DnsAnswerIP;
        tasks.push(async () => {
          const startTime = Date.now();
          try {
            const hostnames = await reverse(entity.value);
            const endTime = Date.now();
            const elapsedTime = endTime - startTime; // Time in milliseconds
            // Since entity.isIP is true, answers is guaranteed to have PTR property
            ipAnswers.PTR.results = hostnames;
            ipAnswers.PTR.elapsedTime = elapsedTime;
            totalAnswers += hostnames.length;
          } catch (queryErr) {
            const endTime = Date.now();
            // Since entity.isIP is true, answers is guaranteed to have PTR property
            ipAnswers.PTR.elapsedTime = endTime - startTime;
            ipAnswers.PTR.error = enrichDnsError(queryErr);
            if (isThrowableError(ipAnswers.PTR.error)) {
              throw queryErr;
            }
          }
        });
      } else {
        // Default to A record lookup if no query types specified
        if (options.queryTypes.length === 0) {
          options.queryTypes.push({
            value: 'A'
          });
        }

        options.queryTypes.forEach((type) => {
          tasks.push(async () => {
            const startTime = Date.now();
            try {
              let results;
              if (type.value === 'A') {
                results = await resolve4(entity.value, { ttl: true });
              } else if (type.value === 'AAAA') {
                results = await resolve6(entity.value, { ttl: true });
              } else {
                results = await resolve(entity.value, type.value);
              }
              const endTime = Date.now();
              const elapsedTime = endTime - startTime; // Time in milliseconds
              // Since entity.isIP is false, answers is guaranteed to be DnsAnswerDomain
              const domainAnswers = answers as DnsAnswerDomain;
              const recordType = type.value as DomainRecordType;
              const record = getDomainRecord(domainAnswers, recordType);

              record.results = Array.isArray(results) ? results : [results];
              record.elapsedTime = elapsedTime;
              totalAnswers += record.results.length;
            } catch (queryErr) {
              logger.error(queryErr, 'DNS Resolve Error');
              const endTime = Date.now();
              const domainAnswers = answers as DnsAnswerDomain;
              const recordType = type.value as DomainRecordType;
              const record = getDomainRecord(domainAnswers, recordType);

              record.elapsedTime = endTime - startTime;
              record.error = enrichDnsError(queryErr);
              if (isThrowableError(record.error)) {
                throw queryErr;
              }
            } finally {
              const domainAnswers = answers as DnsAnswerDomain;
              const recordType = type.value as DomainRecordType;
              const record = getDomainRecord(domainAnswers, recordType);
              record.searched = true;
            }
          });
        });
      }

      await async.parallelLimit(tasks, MAX_TASKS_AT_A_TIME);
      answers = sortAnswers(answers);

      if (isMiss(totalAnswers, options)) {
        lookupResults.push({
          entity,
          data: {
            summary: [],
            details: null
          }
        });
      } else {
        const domainNotFound = isDomainNotFound(answers);
        const reverseDnsNotFound = isReverseDnsNotFound(answers);
        lookupResults.push({
          entity,
          data: {
            summary: _getSummaryTags(answers, domainNotFound, reverseDnsNotFound, totalAnswers),
            details: {
              answer: answers,
              totalAnswers,
              server: dns.getServers(),
              // Don't set this to true for reverse DNS lookups (IP lookups)
              domainNotFound: entity.isDomain && domainNotFound,
              reverseDnsNotFound: entity.isIP && reverseDnsNotFound
            }
          }
        });
      }

      logger.trace({ lookupResults }, 'Lookup Results');
    });
    return lookupResults;
  } catch (lookupError) {
    logger.error({ lookupError }, 'Error in doLookup');
    throw enrichDnsError(lookupError);
  }
}

function isDomainNotFound(answers: DnsAnswer) {
  // when looking up a domain, if the domain does not exist a "ENOTFOUND" error is returned
  // The "syscall" property for the "ENOTFOUND" will be the query type.  We need to check to
  // make sure the "syscall" is not of type "getHostByAddr" as an ENOTFOUND error with this
  // syscall occurs when the server cannot complete a reverse DNS lookup.
  return Object.keys(answers).some((type) => {
    const record = answers[type];
    return (
      record &&
      typeof record === 'object' &&
      'error' in record &&
      record.error &&
      record.error.message === 'Domain name not found.' &&
      record.error.syscall !== 'getHostByAddr'
    );
  });
}

function isReverseDnsNotFound(answers: DnsAnswer) {
  // when looking up an IP, if the IP does not exist a "ENOTFOUND" error is returned
  // The "syscall" property for the "ENOTFOUND" will be 'getHostByAddr'.  We need to check to
  // make sure the "syscall" is not of type "getHostByAddr" as an ENOTFOUND error with this
  // syscall occurs when the server cannot complete a reverse DNS lookup.
  return Object.keys(answers).some((type) => {
    const record = answers[type];
    return (
      record &&
      typeof record === 'object' &&
      'error' in record &&
      record.error &&
      record.error.code === 'ENOTFOUND' &&
      record.error.syscall === 'getHostByAddr'
    );
  });
}

function enrichDnsError(dnsError: any): DnsError {
  let queryErrJson = parseErrorToReadableJson(dnsError);

  if (dnsError.code && typeof dnsError.code === 'string') {
    const errorCode = dnsError.code as keyof typeof DNS_ERRORS;
    const errorCodeWithE = `E${dnsError.code}` as keyof typeof DNS_ERRORS;

    const errorMessage = DNS_ERRORS[errorCode] || DNS_ERRORS[errorCodeWithE];
    if (errorMessage) {
      queryErrJson.message = errorMessage;
      queryErrJson.detail = errorMessage;
    }
  }

  return queryErrJson as DnsError;
}

function isThrowableError(dnsError: DnsError | null): boolean {
  if (!dnsError || !dnsError.code) {
    return false;
  }
  if (dnsError.code === 'ENODATA' || dnsError.code === 'ENOTFOUND' || dnsError.code === 'EBADRESP') {
    return false;
  }
  return true;
}

function isMiss(totalAnswers: number, options: Options): boolean {
  switch (options.resultsToShow.value) {
    case 'always':
      return false;
      break;
    case 'answerOnly':
      return totalAnswers === 0;
      break;
  }
}

/**
 * We sort the answers so that the record with the most data appears first and all query types that we already
 * searched go before query types that have not been searched yet.
 *
 * @param answers
 * @returns {*}
 */
function sortAnswers(answers: DnsAnswer) {
  answers.__order = answers.__order.sort((a, b) => {
    const answerA = answers[a];
    const answerB = answers[b];

    // Type guard to ensure we're working with DnsResult objects
    if (!answerA || !answerB || Array.isArray(answerA) || Array.isArray(answerB)) {
      return 0;
    }

    const resultLengthDiff = answerB.results.length - answerA.results.length;

    return resultLengthDiff === 0 // if there are the same number of results, put the searched answers first
      ? Number(answerB.searched) - Number(answerA.searched) // Otherwise sort by the number of answers returned
      : resultLengthDiff;
  });
  return answers;
}

/**
 * Summary tags will always return the A record first if available.  If there is no A record
 * then it will return the first record with a result.
 *
 * @param answers
 * @param authority
 * @returns {string[]}
 * @private
 */
function _getSummaryTags(
  answers: DnsAnswer,
  domainNotFound: boolean,
  reverseDnsNotFound: boolean,
  totalAnswers: number
): string[] {
  if (domainNotFound) {
    return ['Domain not found'];
  }

  if (reverseDnsNotFound) {
    return ['IP not found'];
  }

  const aRecord = answers['A'];
  if (aRecord && !Array.isArray(aRecord) && aRecord.results.length > 0) {
    let tags = [`A ${(aRecord.results[0] as any).address}`];
    if (totalAnswers > 1) {
      tags.push(`+${totalAnswers - 1} answers`);
    }
    return tags;
  } else if (totalAnswers > 0) {
    const type = answers.__order[0];
    const recordData = answers[type];
    if (!recordData || Array.isArray(recordData)) {
      return ['No Answers'];
    }
    const value = recordData.results[0];
    let tags;
    if (type === 'MX') {
      tags = [`MX ${(value as any).exchange}`];
    } else if (type === 'SOA') {
      tags = [`SOA ${(value as any).nsname}`];
    } else if (type === 'AAAA') {
      tags = [`AAAA ${(value as any).address}`];
    } else {
      tags = [`${type} ${value}`];
    }
    if (totalAnswers > 1) {
      tags.push(`+${totalAnswers - 1} answers`);
    }
    return tags;
  }
  return ['No Answers'];
}

async function onMessage(payload: any, options: Options, context: Context) {
  const { logger } = context;
  switch (payload.action) {
    case 'RETRY_LOOKUP':
      try {
        await doLookup([payload.entity], options, context);
      } catch (err) {
        logger.error({ err }, 'Error retrying lookup');
        throw err;
      }
      break;
    case 'RUN_QUERY':
      const queryType = payload.type;
      const singleTypeOptions = {
        ...options,
        queryTypes: [
          {
            value: queryType
          }
        ]
      };
      try {
        const queryResults = await doLookup([payload.entity], singleTypeOptions, context);
        return {
          answer: queryResults[0].data?.details?.answer[payload.type] || null
        };
      } catch (err) {
        logger.error({ err }, 'Error running query');
        throw err;
      }
      break;
  }
}

module.exports = {
  doLookup,
  startup,
  onMessage
};
