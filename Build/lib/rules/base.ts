import type { Span } from '../../trace';
import { HostnameSmolTrie } from '../trie';
import { not, nullthrow } from 'foxts/guard';
import { fastIpVersion } from 'foxts/fast-ip-version';
import { addArrayElementsToSet } from 'foxts/add-array-elements-to-set';
import type { MaybePromise } from '../misc';
import type { BaseWriteStrategy } from '../writing-strategy/base';
import { merge as mergeCidr } from 'fast-cidr-tools';
import { createRetrieKeywordFilter as createKeywordFilter } from 'foxts/retrie';
import path from 'node:path';
import { SurgeMitmSgmodule } from '../writing-strategy/surge';
import { appendArrayInPlace } from 'foxts/append-array-in-place';

/**
 * Holds the universal rule data (domain, ip, url-regex, etc. etc.)
 * This class is not about format, instead it will call the class that does
 */
export class FileOutput {
  protected strategies: BaseWriteStrategy[] = [];

  protected dataSource = new Set<string>();

  public domainTrie = new HostnameSmolTrie(null);
  public wildcardTrie: HostnameSmolTrie = new HostnameSmolTrie(null);

  protected domainKeywords = new Set<string>();

  private whitelistKeywords = new Set<string>();

  protected userAgent = new Set<string>();
  protected processName = new Set<string>();
  protected processPath = new Set<string>();
  protected urlRegex = new Set<string>();
  protected ipcidr = new Set<string>();
  protected ipcidrNoResolve = new Set<string>();
  protected ipasn = new Set<string>();
  protected ipasnNoResolve = new Set<string>();
  protected ipcidr6 = new Set<string>();
  protected ipcidr6NoResolve = new Set<string>();
  protected geoip = new Set<string>();
  protected groipNoResolve = new Set<string>();

  protected sourceIpOrCidr = new Set<string>();
  protected sourcePort = new Set<string>();
  protected destPort = new Set<string>();
  protected protocol = new Set<string>();

  protected otherRules: string[] = [];

  private pendingPromise: Promise<any> | null = null;

  whitelistDomain = (domain: string) => {
    this.domainTrie.whitelist(domain);
    this.wildcardTrie.whitelist(domain);
    return this;
  };

  whitelistKeyword = (keyword: string) => {
    this.whitelistKeywords.add(keyword);
    return this;
  };

  protected readonly span: Span;

  constructor($span: Span, protected readonly id: string) {
    this.span = $span.traceChild('RuleOutput#' + id);
  }

  protected title: string | null = null;
  withTitle(title: string) {
    this.title = title;
    return this;
  }

  public withStrategies(strategies: BaseWriteStrategy[]) {
    this.strategies = strategies;
    return this;
  }

  withExtraStrategies(strategy: BaseWriteStrategy) {
    this.strategies.push(strategy);
  }

  protected description: string[] | null = null;
  withDescription(description: string[] | readonly string[]) {
    this.description = description as string[];
    return this;
  }

  appendDescription(description: string | string[], ...rest: string[]) {
    this.description ??= [];
    if (typeof description === 'string') {
      this.description.push(description);
    } else {
      appendArrayInPlace(this.description, description);
    }

    if (rest.length) {
      appendArrayInPlace(this.description, rest);
    }

    return this;
  }

  protected date = new Date();
  withDate(date: Date) {
    this.date = date;
    return this;
  }

  addDomain(domain: string) {
    this.domainTrie.add(domain);
    return this;
  }

  bulkAddDomain(domains: Array<string | null>) {
    let d: string | null;
    for (let i = 0, len = domains.length; i < len; i++) {
      d = domains[i];
      if (d !== null) {
        this.domainTrie.add(d, false, null, 0);
      }
    }
    return this;
  }

  addDomainSuffix(domain: string, lineFromDot = domain[0] === '.') {
    this.domainTrie.add(domain, true, null, lineFromDot ? 1 : 0);
    return this;
  }

  bulkAddDomainSuffix(domains: string[]) {
    for (let i = 0, len = domains.length; i < len; i++) {
      this.addDomainSuffix(domains[i]);
    }
    return this;
  }

  addDomainKeyword(keyword: string) {
    this.domainKeywords.add(keyword);
    return this;
  }

  bulkAddDomainKeyword(keywords: string[]) {
    for (let i = 0, len = keywords.length; i < len; i++) {
      this.domainKeywords.add(keywords[i]);
    }
    return this;
  }

  bulkAddDomainWildcard(domains: string[]) {
    for (let i = 0, len = domains.length; i < len; i++) {
      this.wildcardTrie.add(domains[i]);
    }
    return this;
  }

  addIPASN(asn: string) {
    this.ipasn.add(asn);
    return this;
  }

  bulkAddIPASN(asns: string[]) {
    for (let i = 0, len = asns.length; i < len; i++) {
      this.ipasn.add(asns[i]);
    }
    return this;
  }

  private async addFromDomainsetPromise(source: MaybePromise<AsyncIterable<string> | Iterable<string> | string[]>) {
    for await (const line of await source) {
      if (line[0] === '.') {
        this.addDomainSuffix(line, true);
      } else {
        this.domainTrie.add(line, false, null, 0);
      }
    }
  }

  addFromDomainset(source: MaybePromise<AsyncIterable<string> | Iterable<string> | string[]>) {
    if (this.pendingPromise) {
      this.pendingPromise = this.pendingPromise.then(() => this.addFromDomainsetPromise(source));
      return this;
    }
    this.pendingPromise = this.addFromDomainsetPromise(source);
    return this;
  }

  private async addFromRulesetPromise(source: MaybePromise<AsyncIterable<string> | Iterable<string> | string[]>) {
    for await (const line of await source) {
      const splitted = line.split(',');
      const type = splitted[0];
      const value = splitted[1];
      const arg = splitted[2];

      switch (type) {
        case 'DOMAIN':
          this.domainTrie.add(value, false, null, 0);
          break;
        case 'DOMAIN-SUFFIX':
          this.addDomainSuffix(value, false);
          break;
        case 'DOMAIN-KEYWORD':
          this.addDomainKeyword(value);
          break;
        case 'DOMAIN-WILDCARD':
          this.wildcardTrie.add(value);
          break;
        case 'USER-AGENT':
          this.userAgent.add(value);
          break;
        case 'PROCESS-NAME':
          if (value.includes('/') || value.includes('\\')) {
            this.processPath.add(value);
          } else {
            this.processName.add(value);
          }
          break;
        case 'URL-REGEX': {
          const [, ...rest] = splitted;
          this.urlRegex.add(rest.join(','));
          break;
        }
        case 'IP-CIDR':
          (arg === 'no-resolve' ? this.ipcidrNoResolve : this.ipcidr).add(value);
          break;
        case 'IP-CIDR6':
          (arg === 'no-resolve' ? this.ipcidr6NoResolve : this.ipcidr6).add(value);
          break;
        case 'IP-ASN':
          (arg === 'no-resolve' ? this.ipasnNoResolve : this.ipasn).add(value);
          break;
        case 'GEOIP':
          (arg === 'no-resolve' ? this.groipNoResolve : this.geoip).add(value);
          break;
        case 'SRC-IP':
          this.sourceIpOrCidr.add(value);
          break;
        case 'SRC-PORT':
          this.sourcePort.add(value);
          break;
        case 'DEST-PORT':
          this.destPort.add(value);
          break;
        case 'PROTOCOL':
          this.protocol.add(value.toUpperCase());
          break;
        default:
          this.otherRules.push(line);
          break;
      }
    }
  }

  addFromRuleset(source: MaybePromise<AsyncIterable<string> | Iterable<string>>) {
    if (this.pendingPromise) {
      this.pendingPromise = this.pendingPromise.then(() => this.addFromRulesetPromise(source));
      return this;
    }
    this.pendingPromise = this.addFromRulesetPromise(source);
    return this;
  }

  static readonly ipToCidr = (ip: string, version: 4 | 6) => {
    if (ip.includes('/')) return ip;
    if (version === 4) {
      return ip + '/32';
    }
    return ip + '/128';
  };

  addAnyCIDR(cidr: string, noResolve = false) {
    const version = fastIpVersion(cidr);
    if (version === 0) return this;

    let list: Set<string>;
    if (version === 4) {
      list = noResolve ? this.ipcidrNoResolve : this.ipcidr;
    } else /* if (version === 6) */ {
      list = noResolve ? this.ipcidr6NoResolve : this.ipcidr6;
    }

    list.add(FileOutput.ipToCidr(cidr, version));
    return this;
  }

  bulkAddAnyCIDR(cidrs: string[], noResolve = false) {
    const list4 = noResolve ? this.ipcidrNoResolve : this.ipcidr;
    const list6 = noResolve ? this.ipcidr6NoResolve : this.ipcidr6;

    for (let i = 0, len = cidrs.length; i < len; i++) {
      let cidr = cidrs[i];
      const version = fastIpVersion(cidr);
      if (version === 0) {
        continue; // skip invalid IPs
      }
      cidr = FileOutput.ipToCidr(cidr, version);

      if (version === 4) {
        list4.add(cidr);
      } else /* if (version === 6) */ {
        list6.add(cidr);
      }
    }
    return this;
  }

  bulkAddCIDR4(cidrs: string[]) {
    for (let i = 0, len = cidrs.length; i < len; i++) {
      this.ipcidr.add(FileOutput.ipToCidr(cidrs[i], 4));
    }
    return this;
  }

  bulkAddCIDR4NoResolve(cidrs: string[]) {
    for (let i = 0, len = cidrs.length; i < len; i++) {
      this.ipcidrNoResolve.add(FileOutput.ipToCidr(cidrs[i], 4));
    }
    return this;
  }

  bulkAddCIDR6(cidrs: string[]) {
    for (let i = 0, len = cidrs.length; i < len; i++) {
      this.ipcidr6.add(FileOutput.ipToCidr(cidrs[i], 6));
    }
    return this;
  }

  bulkAddCIDR6NoResolve(cidrs: string[]) {
    for (let i = 0, len = cidrs.length; i < len; i++) {
      this.ipcidr6NoResolve.add(FileOutput.ipToCidr(cidrs[i], 6));
    }
    return this;
  }

  /**
   * Add data source information. This will be rendered inside description
   */
  appendDataSource(source: string | string[]) {
    if (typeof source === 'string') {
      this.dataSource.add(source);
    } else {
      addArrayElementsToSet(this.dataSource, source);
    }

    return this;
  }

  async done() {
    await this.pendingPromise;
    this.pendingPromise = null;
    return this;
  }

  // private guardPendingPromise() {
  //   // reverse invariant
  //   if (this.pendingPromise !== null) {
  //     console.trace('Pending promise:', this.pendingPromise);
  //     throw new Error('You should call done() before calling this method');
  //   }
  // }

  // async writeClash(outputDir?: null | string) {
  //   await this.done();

  //   invariant(this.title, 'Missing title');
  //   invariant(this.description, 'Missing description');

  //   return compareAndWriteFile(
  //     this.span,
  //     withBannerArray(
  //       this.title,
  //       this.description,
  //       this.date,
  //       this.clash()
  //     ),
  //     path.join(outputDir ?? OUTPUT_CLASH_DIR, this.type, this.id + '.txt')
  //   );
  // }
  private strategiesWritten = false;

  private writeToStrategies() {
    if (this.pendingPromise) {
      throw new Error('You should call done() before calling writeToStrategies()');
    }
    if (this.strategiesWritten) {
      throw new Error('Strategies already written');
    }

    this.strategiesWritten = true;

    // We use both DOMAIN-KEYWORD and whitelisted keyword to whitelist DOMAIN and DOMAIN-SUFFIX
    const kwfilter = createKeywordFilter(
      Array.from(this.domainKeywords)
        .concat(Array.from(this.whitelistKeywords))
    );

    if (this.strategies.filter(not(false)).length === 0) {
      throw new Error('No strategies to write ' + this.id);
    }

    const strategiesLen = this.strategies.length;

    this.domainTrie.dumpWithoutDot((domain, includeAllSubdomain) => {
      if (kwfilter(domain)) {
        return;
      }

      this.wildcardTrie.whitelist(domain, includeAllSubdomain);

      for (let i = 0; i < strategiesLen; i++) {
        const strategy = this.strategies[i];
        if (includeAllSubdomain) {
          strategy.writeDomainSuffix(domain);
        } else {
          strategy.writeDomain(domain);
        }
      }
    }, true);

    // Now, we whitelisted out DOMAIN-KEYWORD
    const whiteKwfilter = createKeywordFilter(Array.from(this.whitelistKeywords));
    const whitelistedKeywords = Array.from(this.domainKeywords).filter(kw => !whiteKwfilter(kw));

    for (let i = 0; i < strategiesLen; i++) {
      const strategy = this.strategies[i];
      if (whitelistedKeywords.length) {
        strategy.writeDomainKeywords(this.domainKeywords);
      }

      if (this.protocol.size) {
        strategy.writeProtocols(this.protocol);
      }
    }

    this.wildcardTrie.dumpWithoutDot((wildcard) => {
      if (kwfilter(wildcard)) {
        return;
      }

      for (let i = 0; i < strategiesLen; i++) {
        const strategy = this.strategies[i];
        strategy.writeDomainWildcard(wildcard);
      }
    }, true);

    const sourceIpOrCidr = Array.from(this.sourceIpOrCidr);

    for (let i = 0; i < strategiesLen; i++) {
      const strategy = this.strategies[i];

      if (this.userAgent.size) {
        strategy.writeUserAgents(this.userAgent);
      }
      if (this.processName.size) {
        strategy.writeProcessNames(this.processName);
      }
      if (this.processPath.size) {
        strategy.writeProcessPaths(this.processPath);
      }

      if (this.sourceIpOrCidr.size) {
        strategy.writeSourceIpCidrs(sourceIpOrCidr);
      }

      if (this.sourcePort.size) {
        strategy.writeSourcePorts(this.sourcePort);
      }
      if (this.destPort.size) {
        strategy.writeDestinationPorts(this.destPort);
      }
      if (this.otherRules.length) {
        strategy.writeOtherRules(this.otherRules);
      }
      if (this.urlRegex.size) {
        strategy.writeUrlRegexes(this.urlRegex);
      }
    }

    let ipcidr: string[] | null = null;
    let ipcidrNoResolve: string[] | null = null;
    let ipcidr6: string[] | null = null;
    let ipcidr6NoResolve: string[] | null = null;

    if (this.ipcidr.size) {
      ipcidr = mergeCidr(Array.from(this.ipcidr), true);
    }
    if (this.ipcidrNoResolve.size) {
      ipcidrNoResolve = mergeCidr(Array.from(this.ipcidrNoResolve), true);
    }
    if (this.ipcidr6.size) {
      ipcidr6 = Array.from(this.ipcidr6);
    }
    if (this.ipcidr6NoResolve.size) {
      ipcidr6NoResolve = Array.from(this.ipcidr6NoResolve);
    }

    for (let i = 0; i < strategiesLen; i++) {
      const strategy = this.strategies[i];
      // no-resolve
      if (ipcidrNoResolve) {
        strategy.writeIpCidrs(ipcidrNoResolve, true);
      }
      if (ipcidr6NoResolve) {
        strategy.writeIpCidr6s(ipcidr6NoResolve, true);
      }
      if (this.ipasnNoResolve.size) {
        strategy.writeIpAsns(this.ipasnNoResolve, true);
      }
      if (this.groipNoResolve.size) {
        strategy.writeGeoip(this.groipNoResolve, true);
      }

      // triggers DNS resolution
      if (ipcidr?.length) {
        strategy.writeIpCidrs(ipcidr, false);
      }
      if (ipcidr6?.length) {
        strategy.writeIpCidr6s(ipcidr6, false);
      }
      if (this.ipasn.size) {
        strategy.writeIpAsns(this.ipasn, false);
      }
      if (this.geoip.size) {
        strategy.writeGeoip(this.geoip, false);
      }
    }
  }

  write(): Promise<unknown> {
    return this.span.traceChildAsync('write all', async (childSpan) => {
      await childSpan.traceChildAsync('done', () => this.done());

      childSpan.traceChildSync('write to strategies', () => this.writeToStrategies());

      return childSpan.traceChildAsync('output to disk', (childSpan) => {
        const promises: Array<Promise<void> | void> = [];

        const descriptions = nullthrow(this.description, 'Missing description');

        if (this.dataSource.size) {
          descriptions.push(
            '',
            'This file contains data from:'
          );
          appendArrayInPlace(descriptions, Array.from(this.dataSource).sort().map((source) => `  - ${source}`));
        }

        for (let i = 0, len = this.strategies.length; i < len; i++) {
          const strategy = this.strategies[i];

          const basename = (strategy.overwriteFilename || this.id) + '.' + strategy.fileExtension;

          promises.push(
            childSpan.traceChildAsync('write ' + strategy.name, (childSpan) => Promise.resolve(strategy.output(
              childSpan,
              nullthrow(this.title, 'Missing title'),
              descriptions,
              this.date,
              path.join(
                strategy.outputDir,
                strategy.type
                  ? path.join(strategy.type, basename)
                  : basename
              )
            )))
          );
        }

        return Promise.all(promises);
      });
    });
  }

  async compile(): Promise<Array<string[] | null>> {
    await this.done();
    this.writeToStrategies();

    return this.strategies.reduce<Array<string[] | null>>((acc, strategy) => {
      acc.push(strategy.content);
      return acc;
    }, []);
  }

  withMitmSgmodulePath(moduleName: string | null) {
    if (moduleName) {
      this.withExtraStrategies(new SurgeMitmSgmodule(moduleName));
    }
    return this;
  }
}
