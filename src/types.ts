import { RecordWithTtl, CaaRecord, MxRecord, NaptrRecord, SrvRecord, TlsaRecord, AnyRecord, SoaRecord } from 'dns';
import { Result } from 'polarity-integration-utils';

export type QueryType = {
  value: string;
  display?: string;
};

export type ResultsToShow = {
  value: 'always' | 'answerOnly';
  display: string;
};

export type Options = {
  dns: string;
  privateIpOnly: boolean;
  queryTypes: QueryType[];
  resultsToShow: ResultsToShow;
};

export type DnsResult = {
  results:
    | RecordWithTtl[]
    | string[]
    | CaaRecord[]
    | MxRecord[]
    | NaptrRecord[]
    | SrvRecord[]
    | TlsaRecord[]
    | string[][]
    | AnyRecord[]
    | SoaRecord[];
  error: DnsError | null;
  searched: boolean;
  elapsedTime?: number;
};

export type DnsAnswerIP = {
  PTR: DnsResult;
  __order: string[];
  [key: string]: DnsResult | string[];
};

export type DomainRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'SOA';

export type DnsError = Error & {
  code?: string;
  syscall?: string;
  hostname?: string;
  errno?: number;
};

export type DnsAnswerDomain = {
  [K in DomainRecordType]: DnsResult;
} & {
  __order: string[];
  [key: string]: DnsResult | string[] | undefined;
};

export type DnsAnswer = DnsAnswerIP | DnsAnswerDomain;

export type DnsLookupDetails = {
  answer: DnsAnswer;
  totalAnswers: number;
  server: string[];
  domainNotFound: boolean;
  reverseDnsNotFound: boolean;
};

export type LookupResult = Result<DnsLookupDetails | null>;
