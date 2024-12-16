# Polarity DNS Query Integration

![mode:on demand only](https://img.shields.io/badge/mode-on%20demand%20only-blue.svg)

> This integration runs in `On Demand Only` mode

| ![overlay results with a domain](assets/overlay_domain.png) |![overlay results with an ip PTR](assets/overlay_ip_ptr.png)|![overlay results with an IP authority](assets/overlay_ip_authority.png)
|:---:|:---:|:---:|
|*Domain Query with Answers* |*IP Query with PTR Answer*| *IP Query with Authority section*|


The Polarity DNS Query integration leverages the NodeJS Native DNS library to issue DNS queries to a specified DNS server.  The integration allows you to specify what type of query is run.  By default, the integration runs an A record query for domains and a PTR (reverse DNS) query for IP addresses.  

## DNS Query Integration Options

### DNS Server
The DNS Server (host or IP) to perform lookups against. If left blank, the Polarity Server's default DNS server will be used. If an invalid or unreachable DNS Server is provided your `dig` requests will eventually time out. Defaults to `8.8.8.8`.

### Private IPs Only

If checked, the integration will only look up private (RFC-1918) IP addresses. Domains will still be looked up unless you turn domains off via the "Manage Integration Data" option.

### DNS Query Types for Domains

One or more query types to run via dig.  Each selected type requires a separate query to your DNS server.  If no types are selected an A Record query will be issued.  Query types only apply to domains as IPs will always be a PTR query.

### Results Filter

Choose which results are displayed. Defaults to always showing a result. Can also be set to only show results with an Answer section, or to only show results with an Answer or Authority section.

## About Polarity

Polarity is a memory-augmentation platform that improves and accelerates analyst decision making.  For more information about the Polarity platform please see:

https://polarity.io/
