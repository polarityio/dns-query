const async = require('async');
const dns = require('dns');
const { promisify } = require('util');
const resolve = promisify(dns.resolve);
const resolve4 = promisify(dns.resolve4);
const resolve6 = promisify(dns.resolve6);
const reverse = promisify(dns.reverse);

const MAX_TASKS_AT_A_TIME = 5;
const MAX_ENTITIES_AT_A_TIME = 2;

let previousDns = null;

let Logger;
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

function startup(logger) {
  Logger = logger;
}

/**
 * Creates an empty answer response object.  We use this object format to make it easier to display the data in our template.
 * @param entity
 * @returns {{A: {searched: boolean, results: *[]}, TXT: {searched: boolean, results: *[]}, __order: string[], SOA: {searched: boolean, results: *[]}, NS: {searched: boolean, results: *[]}, CNAME: {searched: boolean, results: *[]}, MX: {searched: boolean, results: *[]}, AAAA: {searched: boolean, results: *[]}}|{__order: string[], PTR: {searched: boolean, results: *[]}}}
 */
function getBlankAnswer(entity) {
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

const parseErrorToReadableJson = (error) => JSON.parse(JSON.stringify(error, Object.getOwnPropertyNames(error)));

async function doLookup(entities, options, cb) {
  Logger.trace({ entities, options }, 'doLookup');
  let lookupResults = [];

  if (options.dns.length > 0 && previousDns !== options.dns) {
    Logger.trace({ dnsServer: options.dns }, 'Setting DNS Server');
    dns.setServers([options.dns]);
    previousDns = options.dns;
  }

  try {
    await async.eachLimit(entities, MAX_ENTITIES_AT_A_TIME, async (entity) => {
      // If the private IP only option is set ignore non-private IP addresses
      if (options.privateIpOnly && entity.isIP && !entity.isPrivateIP) {
        Logger.trace('Ignore non-private IP ' + entity.value);
        return;
      }

      let answers = getBlankAnswer(entity);
      let totalAnswers = 0;
      const tasks = [];

      if (entity.isIP) {
        tasks.push(async () => {
          const startTime = Date.now();
          try {
            const hostnames = await reverse(entity.value);
            const endTime = Date.now();
            const elapsedTime = endTime - startTime; // Time in milliseconds
            answers.PTR.results = hostnames;
            answers.PTR.elapsedTime = elapsedTime;
            totalAnswers += hostnames.length;
          } catch (queryErr) {
            const endTime = Date.now();
            answers.PTR.elapsedTime = endTime - startTime;
            answers.PTR.error = enrichDnsError(queryErr);
            if (isThrowableError(answers.PTR.error)) {
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
              answers[type.value].results = Array.isArray(results) ? results : [results];
              answers[type.value].elapsedTime = elapsedTime;
              totalAnswers += answers[type.value].results.length;
            } catch (queryErr) {
              const endTime = Date.now();
              answers[type.value].elapsedTime = endTime - startTime;
              answers[type.value].error = enrichDnsError(queryErr);
              if (isThrowableError(answers[type.value].error)) {
                throw queryErr;
              }
            } finally {
              answers[type.value].searched = true;
            }
          });
        });
      }

      await async.parallelLimit(tasks, MAX_TASKS_AT_A_TIME);
      answers = sortAnswers(answers);

      if (isMiss(totalAnswers, options)) {
        lookupResults.push({
          entity,
          data: null
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

      Logger.trace({ lookupResults }, 'Lookup Results');
    });
    cb(null, lookupResults);
  } catch (lookupError) {
    Logger.error({ lookupError }, 'Error in doLookup');
    cb(enrichDnsError(lookupError));
  }
}

function isDomainNotFound(answers) {
  // when looking up a domain, if the domain does not exist a "ENOTFOUND" error is returned
  // The "syscall" property for the "ENOTFOUND" will be the query type.  We need to check to
  // make sure the "syscall" is not of type "getHostByAddr" as an ENOTFOUND error with this
  // syscall occurs when the server cannot complete a reverse DNS lookup.
  return Object.keys(answers).some((type) => {
    return (
      answers[type].error &&
      answers[type].error.message === 'Domain name not found.' &&
      answers[type].error.syscall !== 'getHostByAddr'
    );
  });
}

function isReverseDnsNotFound(answers) {
  // when looking up an IP, if the IP does not exist a "ENOTFOUND" error is returned
  // The "syscall" property for the "ENOTFOUND" will be 'getHostByAddr'.  We need to check to
  // make sure the "syscall" is not of type "getHostByAddr" as an ENOTFOUND error with this
  // syscall occurs when the server cannot complete a reverse DNS lookup.
  return Object.keys(answers).some((type) => {
    return (
      answers[type].error && answers[type].error.code === 'ENOTFOUND' && answers[type].error.syscall === 'getHostByAddr'
    );
  });
}

function enrichDnsError(dnsError) {
  let queryErrJson = parseErrorToReadableJson(dnsError);

  if (DNS_ERRORS[dnsError.code] || DNS_ERRORS[`E${dnsError.code}`]) {
    queryErrJson.message = DNS_ERRORS[dnsError.code] || DNS_ERRORS[`E${dnsError.code}`];
    queryErrJson.detail = DNS_ERRORS[dnsError.code] || DNS_ERRORS[`E${dnsError.code}`];
  }

  return queryErrJson;
}

function isThrowableError(dnsError) {
  if (dnsError.code === 'ENODATA' || dnsError.code === 'ENOTFOUND') {
    return false;
  }
  return true;
}

function isMiss(totalAnswers, options) {
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
function sortAnswers(answers) {
  answers.__order = answers.__order.sort((a, b) => {
    return answers[b].results.length - answers[a].results.length === 0 // if there are the same number of results, put the searched answers first
      ? Number(answers[b].searched) - Number(answers[a].searched) // Otherwise sort by the number of answers returned
      : answers[b].results.length - answers[a].results.length;
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
function _getSummaryTags(answers, domainNotFound, reverseDnsNotFound, totalAnswers) {
  if (domainNotFound) {
    return ['Domain not found'];
  }

  if (reverseDnsNotFound) {
    return ['IP not found'];
  }

  if (answers['A'] && answers['A'].results.length > 0) {
    let tags = [`A ${answers['A'].results[0].address}`];
    if (totalAnswers > 1) {
      tags.push(`+${totalAnswers - 1} answers`);
    }
    return tags;
  } else if (totalAnswers > 0) {
    const type = answers.__order[0];
    const value = answers[type].results[0];
    let tags;
    if (type === 'MX') {
      tags = [`MX ${value.exchange}`];
    } else if (type === 'SOA') {
      tags = [`SOA ${value.nsname}`];
    } else if (type === 'AAAA') {
      tags = [`AAAA ${value.address}`];
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

function onMessage(payload, options, cb) {
  switch (payload.action) {
    case 'RETRY_LOOKUP':
      doLookup([payload.entity], options, (err, lookupResults) => {
        if (err) {
          Logger.error({ err }, 'Error retrying lookup');
          cb(err);
        } else {
          cb(null, lookupResults[0]);
        }
      });
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

      doLookup([payload.entity], singleTypeOptions, (err, lookupResults) => {
        if (err) {
          Logger.error({ err }, 'Error retrying lookup');
          cb(err);
        } else {
          Logger.trace({ payload, lookupResults }, 'onMessage');
          cb(null, {
            answer: lookupResults[0].data.details.answer[payload.type]
          });
        }
      });
      break;
  }
}

module.exports = {
  doLookup,
  startup,
  onMessage
};
