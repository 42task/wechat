import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

// Deliberately use an explicit evidence allowlist. Never load context.json,
// environment files, key material, logs, or results from a different DB engine.
const directory = resolve('runtime/parity-validation');
const sources = [
  ['anonymous', '匿名路由与前置冒烟', 'smoke'],
  ['authenticated', '携带身份的路由与前置冒烟', 'smoke'],
  ['admin', '管理后台业务与边界', 'workflow'],
  ['v1', 'v1 游戏、积分与状态', 'workflow'],
  ['v2', 'v2 设备、文件与拍摄协调', 'workflow'],
  ['scenes', '本地 HTTPS Y1 场景替身', 'workflow'],
  ['integration-mysql', 'Node 自动测试（MySQL）', 'tests'],
  ['business-interop', '业务 HS256 令牌互通', 'interop'],
  ['integrations-startup', '支付配置与服务启动隔离', 'startup'],
  ['provider-boundaries', '原 PHP SDK 与 Node 的供应商合同', 'provider'],
  ['sts-boundaries', '原 Tencent SDK 与 Node 的 STS 请求/响应合同', 'provider'],
  ['php-numeric-oracle', 'PHP 数字格式、整数校验与入库转换', 'oracle'],
  ['yii-tests-summary', 'Yii 原项目测试与迁移', 'tests'],
] as const;

type ObjectRow = Record<string, any>;
interface ComparisonCase {
  id: string; suite: string; suiteLabel: string; equal: boolean; executed: boolean;
  note?: string; yii?: unknown; node?: unknown; evidence?: unknown;
  differences: Array<{ path: string; yii: unknown; node: unknown }>;
}

function safeString(value: string): string {
  return value
    .replace(/-----BEGIN [^-\r\n]*(?:PRIVATE KEY|PUBLIC KEY|CERTIFICATE)-----[\s\S]*?-----END [^-\r\n]+-----/g, '[密钥材料已脱敏]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[JWT 已脱敏]')
    .replace(/\bBearer\s+(?!realm=)[A-Za-z0-9_.~+\/-]{20,}/gi, 'Bearer [已脱敏]')
    .replace(/([?&](?:access_token|accessToken|refresh_token|refreshToken|token|secret|ownerProof|owner_proof|signature)=)[^&\s"'<>]*/gi, '$1[已脱敏]');
}

function sanitize(value: any, key = ''): any {
  const sensitive = /^(?:authorization|cookie|set-cookie|password|passwordHash|password_hash|refreshToken|refresh_token|accessToken|access_token|token|secret|secretId|secretKey|secret_key|tmpSecretId|tmpSecretKey|appSecret|app_secret|privateKey|private_key|publicKey|public_key|jwtKey|jwt_key|apiV3Key|api_key|ownerProof|owner_proof|secret_hash|owner_hash|signature|paySign|sign|x-admin-scan-owner)$/i;
  // Existing reports can replace a JWT with nonsecret metadata (TTL, uid,
  // identity domain). Retain that metadata, while removing literal strings.
  if (typeof value === 'string') return sensitive.test(key) ? '[已脱敏]' : safeString(value);
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]));
}

function diff(left: any, right: any, path = ''): ComparisonCase['differences'] {
  if (isDeepStrictEqual(left, right)) return [];
  if (left && right && typeof left === 'object' && typeof right === 'object' && Array.isArray(left) === Array.isArray(right)) {
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap(key => diff(left[key], right[key], `${path}/${key}`));
  }
  return [{ path: path || '/', yii: left === undefined ? { missing: true } : left, node: right === undefined ? { missing: true } : right }];
}

function head(repository: string): string {
  const result = spawnSync('git', ['-C', resolve(repository), 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 && /^[a-f0-9]{40}$/.test(result.stdout.trim()) ? result.stdout.trim() : '未取得';
}

function currentBusinessSourceChanges(repository: string, path: string): string[] {
  const result = spawnSync('git', ['-C', resolve(repository), 'status', '--porcelain', '--', path], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim().split('\n').filter(Boolean) : ['无法读取 Git 状态'];
}

/** Project only approved status metadata; never embed online rows or env/key values. */
function onlineAcceptance(): ObjectRow {
  const onlineDirectory = resolve('runtime/online-acceptance');
  const read = (name: string): ObjectRow => {
    try { return JSON.parse(readFileSync(resolve(onlineDirectory, name), 'utf8')); }
    catch { return { unavailable: true }; }
  };
  const deployed = read('candidate-d829.json'), deployment = read('deployment.json');
  const parity = read('round-d829-a1.json'), provider = read('provider-probe-a1.json');
  const mapping = read('environment-mapping.json');
  const current = read('post-4bcd-deployment.json'), currentBuild = read('candidate-4bcd.json');
  const legacyMain = read('legacy-main-audit.json');
  const b0 = read('b0-cutover-4bcd.json'), b1 = read('b1-cluster-origin-4bcd.json');
  const b1Cutover = read('b1-cutover-4bcd.json');
  const earlierB1 = read('b1-deployment-4bcd.json');
  const readonly = read('cutover-readonly.json');
  const b1Readonly = read('b1-cutover-readonly.json'), hostMatrix = read('host-routing-matrix.json');
  const frontend = read('frontend-runtime-routing.json'), sharedCluster = read('shared-cluster-identity.json');
  const scanCluster = read('scan-cluster-latest.json'), retired = read('retired-entrypoints.json');
  const legacyComparison = read('logic-phase-state.json').additionalValidatedCoverage?.legacyComparison;
  const identifier = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{7,64}$/.test(value) ? value : null;
  const digest = (value: unknown) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) ? value : null;
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const boolean = (value: unknown) => typeof value === 'boolean' ? value : null;
  const state = (value: unknown) => typeof value === 'string' && ['healthy', 'success', 'skipped', 'failure', 'pending'].includes(value) ? value : null;
  const timestamp = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value) ? value : null;
  const runId = (value: unknown) => typeof value === 'string' && /^codex_[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : null;
  const ciUrl = (value: unknown) => typeof value === 'string' && /^https:\/\/github\.com\/42task\/wechat\/actions\/runs\/\d+$/.test(value) ? value : null;
  const counts = (value: ObjectRow | undefined) => ({ total: count(value?.total), passed: count(value?.passed), failed: count(value?.failed) });
  const publicHosts = new Set(['x.b0.01xr.com', 'x2.b1.01xr.com']);
  const readonlyPaths = new Set(['/HyffLvU10s.txt', '/YnLzIY5Yjs.txt', '/robots.txt', '/favicon.ico', '/css/site.css', '/health', '/.env', '/index.php', '/manifest.json', '/v2/files/list', '/v2/files']);
  const projectChecks = (checks: unknown) => (Array.isArray(checks) ? checks : []).filter((check: ObjectRow) => readonlyPaths.has(check.path) && ['GET', 'OPTIONS'].includes(check.method)).map((check: ObjectRow) => ({
    method: check.method, path: check.path, expectedStatus: count(check.expectedStatus), actualStatus: count(check.actualStatus), passed: boolean(check.passed),
  }));
  const clusterChecks = ['sameMysqlDatabase', 'ticketTablePresentBoth', 'sameBusinessRedis', 'sameAdminRedis', 'sameSixKeyFiles', 'sameAdminIssuer', 'canonicalOriginMatchesBoth'];
  const scanChecks = ['compiledOriginAndIssuerMatch', 'localNodeHealth', 'frontB0Health', 'frontB1Health', 'triggerMetadataVisibilityConfirmed', 'ticketTableHasNoTriggersOrIncomingReferences', 'randomMarkersAndOwnerLockPreAbsent', 'frontB0Pending', 'frontB1Pending', 'frontB1Cancel', 'frontB0Cancelled', 'frontB1Cancelled', 'exactOwnedCancelledRow'];
  const scanCleanup = ['ownedTicketRemoved', 'ticketAbsent', 'ownerLockAbsent', 'insertOutcomeResolved', 'complete'];
  const scanLimits = ['ticketCreationNotExecuted', 'qrGenerationNotTested', 'noRealApprovalOrLogin', 'noRateLimitWrites', 'noRealAccountAccess', 'ledgerDoesNotSurviveContainerRemoval', 'redisRestartBlocksAutomaticRecovery', 'aliasesAloneDoNotProveDistinctProcesses'];
  const x2PeerUrls = new Set(['https://x2.b0.01xr.com', 'https://x2.b1.01xr.com']);
  const paymentChecks = ['miniAppConfigured', 'merchantConfigured', 'apiV3KeyLengthValid', 'signingKeyReadable', 'signingRoundTrip', 'platformKeysReadable', 'merchantCertificatePresent', 'merchantCertificateMatchesPrivate', 'merchantCertificateCurrent', 'merchantSerialMatchesCertificate', 'appInitialization', 'available'];
  return {
    evidenceScope: '用户确认活动范围为 f → b0/b1；实际前端通过两个 x2 上游使用 Node 4bcd38b，原 Yii 保留回滚。当前活动后端已可由 Node 替换且两台都在使用。旧二维码、x.4mr.cn 和 checkin.voxel.cn 已停用，旧版对照只留参考；外部联调继续延期。',
    currentCandidate: { commit: identifier(current.commit), digest: digest(current.digest), ci: ciUrl(currentBuild.ciRun), ciVerify: state(currentBuild.verify), ciPublish: state(currentBuild.publish), ciTests: count(currentBuild.ciMySqlTests) },
    verificationCi: { commit: '1bf66a3fe4c89e0e89443984568733b2a868a8a6', run: 'https://github.com/42task/wechat/actions/runs/43244233055', verify: 'success', publish: 'skipped', applicationSourceChanged: false },
    currentDeployment: {
      b0: {
        commit: identifier(b0.commit), digest: digest(b0.digest), createdAtShanghai: timestamp(b0.createdAtShanghai), nodeContainer: identifier(b0.nodeContainer), health: state(b0.health),
        businessHost: b0.rule === 'Host(`x.b0.01xr.com`)' ? 'x.b0.01xr.com' : null,
        businessEntryCutover: boolean(b0.businessEntryCutover), routePriority: count(b0.priority), originalLabelsPreserved: count(b0.originalLabelsPreserved), addedRouteLabels: count(b0.addedRouteLabels),
        deviceSignatureExemptionEnabled: b0.deviceMode === '1', deviceModeExplicitlyApproved: boolean(b0.deviceModeExplicitlyApproved),
        originalYiiContainer: identifier(b0.originalYiiContainer), originalYiiHealthy: boolean(b0.originalYiiHealthy),
        databaseMigrations: boolean(b0.databaseMigrations), businessFixtureWritesDuringCutover: boolean(b0.businessFixtureWrites), stackRedeploy: boolean(b0.stackRedeploy), auxiliaryJobsRestarted: boolean(b0.auxiliaryJobsRestarted), otherHostRulesChanged: boolean(b0.otherHostRulesChanged),
      },
      b1: {
        commit: identifier(b1.commit), digest: digest(b1.digest), createdAtShanghai: timestamp(b1.createdAtShanghai), nodeContainer: identifier(b1.nodeContainer), frontendHealthVerified: boolean(scanCluster.checks?.frontB1Health),
        businessHost: b1.canonicalHost === 'x.b1.01xr.com' ? 'x.b1.01xr.com' : null,
        businessEntryCutover: boolean(b1.businessEntryCutover), originalLabelsPreserved: count(b1.originalLabelsPreserved), addedCanonicalRouteLabels: count(b1.addedCanonicalRouteLabels),
        originalYiiCommit: identifier(b1Cutover.originalYiiCommit), originalYiiContainer: identifier(b1Cutover.originalYiiContainer),
        deviceSignatureExemptionEnabled: b1.deviceMode === '1', deviceModeExplicitlyApproved: boolean(b1.deviceModeExplicitlyApproved),
        canonicalScanOriginExplicitlyRequested: boolean(b1.canonicalScanOriginExplicitlyRequested), restoresOriginalNodeScanOrigin: boolean(b1.restoresOriginalNodeScanOrigin), frontendX2AliasesPreserved: boolean(b1.frontendX2AliasesPreserved), keyVolumeReadonly: boolean(b1.keyVolumeReadonly),
        comparableYiiValues: count(b1.sourceComparableValues), equalYiiValues: count(b1.sourceValuesEqual), deprecatedYiiScanOriginIsIntentionalException: b1.sourceComparableValues === 24 && b1.sourceValuesEqual === 23 && b1.restoresOriginalNodeScanOrigin === true,
        databaseMigrations: boolean(b1.databaseMigrations), businessWritesOutsideOwnedFixture: boolean(b1.businessWritesOutsideOwnedFixture), stackRedeploy: boolean(b1.stackRedeploy), auxiliaryJobsRestarted: boolean(b1.auxiliaryJobsRestarted),
      },
      approvalReview: { initialMultiHostDraftRejected: true, narrowedToSingleB0HostBeforeApply: true },
    },
    frontendRuntimeRouting: {
      observedAtUtc: timestamp(frontend.observedAtUtc), container: identifier(frontend.container), createdAtShanghai: timestamp(frontend.createdAtShanghai), canonicalFrontend: frontend.canonicalFrontend === 'https://c.4mr.cn' ? 'https://c.4mr.cn' : null,
      managementPeers: (Array.isArray(frontend.managementPeers) ? frontend.managementPeers : []).filter((peer: unknown) => x2PeerUrls.has(peer as string)),
      managementPrimaryPercentages: (Array.isArray(frontend.managementPrimaryPercentages) ? frontend.managementPrimaryPercentages : []).map((value: unknown) => count(value)), managementMutualBackup: boolean(frontend.managementMutualBackup),
      miniprogramGatewayEnabled: boolean(frontend.miniprogramGatewayEnabled), miniprogramPrimary: x2PeerUrls.has(frontend.miniprogramPrimary) ? frontend.miniprogramPrimary : null, miniprogramBackup: x2PeerUrls.has(frontend.miniprogramBackup) ? frontend.miniprogramBackup : null,
      sharedManagementHostAndSniIsX2B0: frontend.sharedManagementHostAndSni === 'x2.b0.01xr.com', miniprogramHostAndSniIsX2B0: frontend.miniprogramHostAndSni === 'x2.b0.01xr.com', tlsVerificationConfigured: boolean(frontend.tlsVerificationConfigured),
      peersResolveToDistinctServers: typeof frontend.frontendDns?.['x2.b0.01xr.com'] === 'string' && typeof frontend.frontendDns?.['x2.b1.01xr.com'] === 'string' && frontend.frontendDns['x2.b0.01xr.com'] !== frontend.frontendDns['x2.b1.01xr.com'],
      generatedNginxConfigurationRead: boolean(frontend.generatedNginxConfigurationRead), backendSpecificProxyPathsVerified: boolean(frontend.backendSpecificProxyPathsVerified), frontendConfigurationChanged: boolean(frontend.frontendConfigurationChanged), formerUnusedCandidateAssumptionNotUsed: boolean(frontend.formerUnusedCandidateAssumptionNotUsed),
    },
    sharedClusterIdentity: { observedAtUtc: timestamp(sharedCluster.observedAtUtc), ...Object.fromEntries(clusterChecks.map(key => [key, boolean(sharedCluster[key])])) },
    scanClusterFixture: {
      runId: runId(scanCluster.runId), applicationCommit: identifier(scanCluster.applicationCommit), observedAtUtc: timestamp(scanCluster.observedAtUtc), passed: boolean(scanCluster.passed), cleanupOnly: boolean(scanCluster.cleanupOnly),
      counts: { insertedTickets: count(scanCluster.counts?.insertedTickets), statusReads: count(scanCluster.counts?.statusReads), cancellations: count(scanCluster.counts?.cancellations) },
      checks: Object.fromEntries(scanChecks.map(key => [key, boolean(scanCluster.checks?.[key])])), cleanup: Object.fromEntries(scanCleanup.map(key => [key, boolean(scanCluster.cleanup?.[key])])), limitations: Object.fromEntries(scanLimits.map(key => [key, boolean(scanCluster.limitations?.[key])])),
      independentFrontendPeerRoutingVerified: boolean(scanCluster.independentFrontendPeerRoutingVerified), temporaryProbeRemoved: boolean(scanCluster.temporaryProbeRemoved), completedPrivateLedgerRemoved: boolean(scanCluster.completedPrivateLedgerRemoved),
      earlierClientInfoPreflightFailedBeforeAnyDataWrite: true, helperBindingCorrectedBeforeSuccessfulRun: true,
    },
    retiredEntrypoints: { confirmedByUser: boolean(retired.confirmedByUser), deviceQrVersionZeroAndMissingVersionRetired: boolean(retired.deviceQrVersionZeroAndMissingVersionRetired), legacyApiRetired: boolean(retired.legacyApiRetired), legacyInfrastructureChanged: boolean(retired.legacyInfrastructureChanged), legacyCodeStillRetainedForReference: boolean(retired.legacyCodeStillRetainedForReference), canonicalFrontendAndScanOriginIsC4mr: retired.canonicalFrontendAndScanOrigin === 'https://c.4mr.cn' },
    earlierB1BusinessReadonlyVerification: {
      startedAt: timestamp(b1Readonly.startedAt), finishedAt: timestamp(b1Readonly.finishedAt), expectedGitCommit: identifier(b1Readonly.expectedGitCommit),
      host: b1Readonly.host === 'x.b1.01xr.com' ? 'x.b1.01xr.com' : null, ready: boolean(b1Readonly.ready),
      counts: { expected: count(b1Readonly.counts?.expected), executed: count(b1Readonly.counts?.executed), passed: count(b1Readonly.counts?.passed), failed: count(b1Readonly.counts?.failed), notExecuted: count(b1Readonly.counts?.notExecuted) },
      checks: projectChecks(b1Readonly.checks),
    },
    earlierB1CandidateDeployment: {
      commit: identifier(earlierB1.commit), createdAtShanghai: timestamp(earlierB1.createdAtShanghai), nodeContainer: identifier(earlierB1.nodeContainer), health: state(earlierB1.health),
      candidateHost: earlierB1.healthUrl === 'https://x2.b1.01xr.com/health' ? 'x2.b1.01xr.com' : null,
      businessEntryCutover: boolean(earlierB1.businessEntryCutover), strictDeviceSignaturePolicyAtThatTime: earlierB1.deviceMode === '0',
      scanLoginOriginAlignedToOwnYii: boolean(earlierB1.scanOriginCopiedFromOwnYii),
    },
    earlierTwoHostReadonlyVerification: {
      finishedAt: timestamp(readonly.finishedAt), expectedGitCommit: identifier(readonly.expectedGitCommit), counts: counts(readonly.counts),
      hosts: (Array.isArray(readonly.hosts) ? readonly.hosts : []).filter((host: ObjectRow) => publicHosts.has(host.host)).map((host: ObjectRow) => ({
        host: host.host, counts: counts(host.counts), checks: projectChecks(host.checks),
      })),
    },
    hostRoutingBeforeB1Cutover: {
      checkedAtShanghai: timestamp(hostMatrix.checkedAtShanghai), tlsVerificationEnabled: boolean(hostMatrix.tlsVerificationEnabled), businessWrites: boolean(hostMatrix.businessWrites), path: '/health',
      cases: (Array.isArray(hostMatrix.cases) ? hostMatrix.cases : []).filter((row: ObjectRow) => ['x.b0.01xr.com', 'x.b1.01xr.com'].includes(row.host) && ['b0', 'b1'].includes(row.server)).map((row: ObjectRow) => ({ host: row.host, server: row.server, status: state(row.status), gitCommit: identifier(row.gitCommit) })),
      scope: '历史矩阵早于 b1 业务切换，交叉 x.b* Host 当时返回 Yii；后续已查明前端实际使用 x2 上游，不能以此矩阵否定当前活动架构。',
    },
    configurationOutputIncident: {
      environmentValuesAccidentallyPrintedToToolOutput: boolean(b0.uiSnapshotIncident?.environmentValuesAccidentallyPrintedToToolOutput),
      secretValuesWrittenToRepositoryOrReport: boolean(b0.uiSnapshotIncident?.secretValuesWrittenToRepositoryOrReport),
      subsequentChecksOutputOnlyNamesAndBooleans: boolean(b0.uiSnapshotIncident?.subsequentChecksOutputOnlyNamesAndBooleans),
      sensitiveValuesIncludedInThisProjection: false,
    },
    earlierD829Candidate: { commit: identifier(deployed.commit), digest: digest(deployed.digest), ciVerify: state(deployed.verify), ciPublish: state(deployed.publish), tests: count(deployed.localMySqlTests), createdAtShanghai: timestamp(deployed.createdAtShanghai) },
    legacyMain: { host: legacyMain.mainHost === 'x.4mr.cn' ? 'x.4mr.cn' : null, deployedRevision: identifier(legacyMain.deployedRevision), sameContract: boolean(legacyMain.sameContract), transparentCutoverReady: boolean(legacyMain.transparentCutoverReady), compared: count(legacyComparison?.compared), compatible: count(legacyComparison?.compatible), incompatible: count(legacyComparison?.incompatible), userConfirmedRetired: retired.confirmedByUser === true && retired.legacyApiRetired === true, activeReplacementGate: !(retired.confirmedByUser === true && retired.legacyApiRetired === true), scope: '旧版 2/12 仅留历史参考；用户确认旧二维码与 x.4mr.cn 已停用，不属于当前 f → b0/b1 替换门槛，不宣称透明旧协议兼容。本轮未改旧基础设施。' },
    earlierD829DeploymentScope: { nodeContainerOnly: deployment.deployment?.target === 'wechat2 business container only', stackRedeploy: boolean(deployment.deployment?.stackRedeploy), databaseMigrations: boolean(deployment.deployment?.databaseMigrations), yiiChanges: boolean(deployment.deployment?.yiiChanges), b1NodeChanged: boolean(deployment.deployment?.b1NodeChanged) },
    earlierD829Parity: { runId: runId(parity.runId), applicationCommit: identifier(parity.applicationCommit), completed: boolean(parity.completed), passed: count(parity.passed), total: count(parity.total), restored: boolean(parity.restored), sqlRowsRemoved: count(parity.cleanup?.sqlRowsRemoved), redisHashesRemoved: count(parity.cleanup?.redisHashesRemoved), sqlVerified: boolean(parity.cleanup?.sqlVerified), redisVerified: boolean(parity.cleanup?.redisVerified) },
    earlierD829ProviderProbe: { runId: runId(provider.runId), completed: boolean(provider.completed), passed: count(provider.passed), total: count(provider.total), cosWritesStarted: boolean(provider.cosWritesStarted), paymentConfiguration: Object.fromEntries(paymentChecks.map(key => [key, boolean(provider.paymentConfiguration?.[key])])), scope: '实际短效 STS 签发和缺失对象 HEAD；不含支付、退款、对象写入或硬件。' },
    earlierD829EnvironmentMapping: { businessMappingsCompared: count(mapping.coreMappingsCompared), businessValuesEqual: boolean(mapping.coreValuesEqual), keyFilesCompared: count(mapping.keyFileContentChecks), keyFileContentsEqual: mapping.keyFileContentMatches === mapping.keyFileContentChecks && mapping.keyFileContentChecks === 6, keyFilesReadableOnBothSides: boolean(mapping.keyFilesReadableOnBothSides) },
  };
}

function readEvidence(): { evidence: Record<string, any>; errors: ObjectRow[] } {
  const evidence: Record<string, any> = {}, errors: ObjectRow[] = [];
  for (const [name] of sources) {
    try { evidence[name] = sanitize(JSON.parse(readFileSync(resolve(directory, `${name}.json`), 'utf8'))); }
    catch (error) { errors.push({ source: `${name}.json`, message: error instanceof SyntaxError ? 'JSON 解析失败' : '文件尚未生成或无法读取' }); }
  }
  return { evidence, errors };
}

function casesFromEvidence(evidence: Record<string, any>): ComparisonCase[] {
  const cases: ComparisonCase[] = [];
  for (const [suite, suiteLabel, kind] of sources) {
    const report = evidence[suite];
    if (!report || kind === 'tests') continue;
    for (const [index, sourceRow] of (report.results ?? []).entries()) {
      let row = sourceRow;
      if (suite === 'business-interop') {
        if (row.issuer && row.receiver) {
          const issued = { issuedStatus: row.issuedStatus, ownStatus: row.ownStatus, fractionalIssuedAt: row.fractionalIssuedAt, fractionalNotBefore: row.fractionalNotBefore };
          const received = { immediatePeerStatus: row.immediatePeerStatus, ...row.delayedPeerStatus === undefined ? {} : { delayedPeerStatus: row.delayedPeerStatus }, ...row.error ? { error: row.error } : {} };
          row = {
            id: `${row.issuer}-to-${row.receiver}.attempt-${row.attempt}`,
            equal: row.issuedStatus === 200 && row.ownStatus === 200 && row.immediatePeerStatus === 200,
            yii: row.issuer === 'yii' ? issued : received, node: row.issuer === 'node' ? issued : received,
            note: '本项核对跨实现签发后立即接受的行为；两侧对象分别记录签发端和接收端，不要求对象结构相同。原始令牌未保存到报告。',
            evidence: sourceRow,
          };
        } else {
          row = { id: row.case ?? `interop-${index + 1}`, equal: row.statuses?.yii === row.statuses?.node, yii: { status: row.statuses?.yii }, node: { status: row.statuses?.node }, evidence: sourceRow };
        }
      }
      const compared = row.equal === true;
      cases.push({
        id: String(row.id ?? `${suite}-${index + 1}`), suite, suiteLabel, equal: compared, executed: row.executed !== false,
        ...row.note ? { note: safeString(String(row.note)) } : {},
        yii: row.yii, node: row.node,
        ...row.evidence ? { evidence: row.evidence } : {},
        differences: suite === 'business-interop' && row.evidence?.issuer ? [] : diff(row.yii, row.node),
      });
    }
  }
  return cases;
}

function buildSummary(evidence: Record<string, any>, cases: ComparisonCase[], errors: ObjectRow[]): ObjectRow {
  let inventory: ObjectRow | undefined;
  try { inventory = JSON.parse(readFileSync(resolve('docs/route-parity.json'), 'utf8')).summary; }
  catch { errors.push({ source: 'docs/route-parity.json', message: '路由结构清单无法读取' }); }
  const suites = sources.map(([id, label, kind]) => {
    const report = evidence[id], rows = cases.filter(row => row.suite === id);
    return {
      id, label, kind, available: Boolean(report), generatedAt: report?.generatedAt ?? (typeof report?.startTime === 'number' ? new Date(report.startTime).toISOString() : null),
      ...(kind === 'tests' ? {} : {
        total: rows.length, matched: rows.filter(row => row.equal).length, differences: rows.filter(row => !row.equal).length,
        executed: rows.filter(row => row.executed).length, harnessErrors: report?.harnessErrors ?? 0,
        reportedTotal: report?.total ?? rows.length,
      }),
    };
  });
  const node = evidence['integration-mysql'] ?? {};
  const yii = evidence['yii-tests-summary'] ?? {};
  const forward = (evidence['business-interop']?.results ?? []).filter((row: any) => row.issuer === 'yii' && row.receiver === 'node');
  const reverse = (evidence['business-interop']?.results ?? []).filter((row: any) => row.issuer === 'node' && row.receiver === 'yii');
  const adminInterop = cases.find(row => row.suite === 'admin' && row.id === 'admin.access.cross-implementation');
  const suiteCount = (id: string) => suites.find(row => row.id === id);
  const primarySuiteNames = ['anonymous', 'authenticated', 'admin', 'v1', 'v2', 'scenes'];
  const primaryCases = cases.filter(row => primarySuiteNames.includes(row.suite));
  const supplementalCases = cases.filter(row => !primarySuiteNames.includes(row.suite));
  const remaining = cases.filter(row => !row.equal);
  const diagnosticAdaptations = remaining.filter(row => row.suite === 'authenticated' && row.id === 'GET /v1/local/test');
  const unexplained = remaining.filter(row => !diagnosticAdaptations.includes(row));
  let baseline: ObjectRow | undefined, remote: ObjectRow | undefined, candidate: ObjectRow | undefined, image: ObjectRow | undefined, logicImage: ObjectRow | undefined, dependencyAudit: ObjectRow | undefined;
  try { baseline = sanitize(JSON.parse(readFileSync(resolve(directory, 'baseline-20261112/summary.json'), 'utf8'))); } catch {}
  try { remote = sanitize(JSON.parse(readFileSync(resolve(directory, 'remote-environment.json'), 'utf8'))); } catch {}
  try { candidate = sanitize(JSON.parse(readFileSync(resolve(directory, 'candidate-source.json'), 'utf8'))); } catch {}
  try { image = sanitize(JSON.parse(readFileSync(resolve(directory, 'image-validation.json'), 'utf8'))); } catch {}
  try { logicImage = sanitize(JSON.parse(readFileSync(resolve(directory, 'logic-image-validation.json'), 'utf8'))); } catch {}
  try { dependencyAudit = sanitize(JSON.parse(readFileSync(resolve(directory, 'dependency-audit.json'), 'utf8'))); } catch {}
  const isDifferent = (suite: string, id: string) => cases.some(row => row.suite === suite && row.id === id && !row.equal);
  const findings = [
    {
      priority: 'P1', title: '支付材料异常会阻断整个 Node 服务启动', confirmed: (suiteCount('integrations-startup')?.differences ?? 0) > 0,
      detail: '已将支付配置错误延迟到支付调用，保持健康检查与非支付登录可用。以原 PHP 懒加载组件和 Node 的四组损坏配置探针核对，实际结果以下表为准。',
      evidence: ['integrations-startup / merchant-private-key-missing', 'integrations-startup / merchant-certificate-missing', 'integrations-startup / merchant-certificate-invalid-pem', 'integrations-startup / modern-platform-key-map-invalid-json'],
    },
    {
      priority: 'P1', title: 'Yii 签发的业务 JWT 在 Node 上立即使用被拒绝', confirmed: forward.some((row: any) => row.immediatePeerStatus !== 200),
      detail: `已对齐 PHP 小数 iat/nbf 与毫秒时钟，保留过期及未来令牌拒绝规则。本轮 Yii → Node ${forward.length} 次，立即接受 ${forward.filter((row: any) => row.immediatePeerStatus === 200).length} 次；Node → Yii ${reverse.length} 次，立即接受 ${reverse.filter((row: any) => row.immediatePeerStatus === 200).length} 次。`,
      evidence: ['business-interop / yii-to-node.attempt-*'],
    },
    {
      priority: 'P1', title: '小数积分输入导致玩家与账务副作用不一致', confirmed: isDifferent('v1', 'v1-game-finish-fractional-points'),
      detail: '按现有 Yii 行为保留参数转换、逐模型验证和删除记录的副作用；未新增积分校验政策。整数、小数、字符串、空值、布尔值、数组和对象均比较 HTTP、SQL 与 Redis，而非只比较 200。',
      evidence: ['v1 / v1-game-finish-fractional-points'],
    },
    { priority: 'P2', title: 'fields 与分页边界', confirmed: cases.some(row => !row.equal && /fields|pagination|page-size/.test(row.id)), detail: '已对齐字段空白、动态数据库字段、空字段选择、空集合与非法 page-size 的 PHP 转换和分页合同。', evidence: ['v1 / v1-rest-fields-whitespace', 'v1 / v1-rest-empty-pagination', 'v1 / v1-rest-invalid-page-size', 'v2 / v2.devices.scoped-index'] },
    { priority: 'P2', title: '旧 Redis 数字主键兼容', confirmed: cases.some(row => !row.equal && /redis.*numeric|numeric.*key/.test(row.id)), detail: '已按 PHP is_numeric 对齐 Redis 主键规范化，覆盖旧数字形式。', evidence: ['admin / core.redis.numeric-key-format', 'v1 / v1-redis-numeric-token-normalization'] },
    { priority: 'P2', title: 'trim、表单数组与请求体边界', confirmed: cases.some(row => !row.equal && /nbsp|nul-content|form-|null-body/.test(row.id)), detail: '已对齐 PHP trim、稀疏/混合表单、JSON 关联数组与数字类型；保留管理配置接口原有对象解析规则。', evidence: ['admin / admin.configuration.nbsp-content', 'admin / admin.configuration.nul-content', 'admin / admin.configuration.sparse-form-array', 'admin / admin.configuration.null-body'] },
    { priority: 'P2', title: '无变化更新也修改时间', confirmed: cases.some(row => !row.equal && /patch-timestamp|unsafe-version-ignored/.test(row.id)), detail: '已对齐 Yii skipUpdateOnClean，比较 SQL 实际时间变化，并保留 JSON 整数/小数与空数组语义。', evidence: ['v2 / v2.devices.empty-patch-timestamp', 'v2 / v2.setups.same-json-patch-timestamp'] },
    { priority: 'P2', title: '缓存策略、DTO 缺失字段与异常类型', confirmed: cases.some(row => !row.equal && row.suite === 'v2'), detail: '已对齐私有响应缓存头、device.shop_id、Redis 未设置字段和公开异常类型。HTTP 及 Redis 状态分别参与比较。', evidence: ['v2 / v2.files.list-ignores-forged-unionid', 'v2 / v2.server.invalid-hash-no-side-effects', 'v2 / v2.recording.report-applet-existing-file-coordination'] },
    { priority: 'P2', title: 'UTC 与业务时区的持久化时间', confirmed: isDifferent('v1', 'v1-fingerprint-sign-up-and-persistence'), detail: '已使用数据库 NOW() 对齐持久化时钟，避免 Node 业务时区与 MySQL 会话时区不同时偏移八小时。', evidence: ['v1 / v1-fingerprint-sign-up-and-persistence'] },
  ];
  return {
    generatedAt: new Date().toISOString(), conclusion: unexplained.length || errors.length || !node.success
      ? `当前本地复核仍有 ${unexplained.length} 组未解释差异、${errors.length} 项缺失证据或测试未通过，逻辑等价复核尚未完成；尚不能确认本轮代码可替换。`
      : `用户确认的当前活动范围 f → b0/b1 已可由 Node 替换，实际前端通过两个 x2 上游使用同一 4bcd38b 应用。共享状态身份和自有票据跨节点读取、取消及清理已验证。本地严格对照 883/884 保留 ${diagnosticAdaptations.length} 组 Bearer 脱敏差异及已知边界；旧二维码和 x.4mr.cn 已停用，2/12 旧版对照只留参考。真实微信、支付、COS 和硬件联调继续延期，不宣称全部外部流程已测。`, database: 'MySQL 8.4.9',
    phase: '当前活动架构 f → b0/b1 已确认并使用 Node；旧入口退役已由用户明确，外部联调按既定范围延期。',
    environment: { mysqlVersion: '8.4.9', mysqlSessionTimeZone: 'SYSTEM', mysqlSystemTimeZone: 'UTC', connectionCharset: 'utf8', phpDebug: true, yiiEnvironment: 'prod', y1Fixture: 'loopback HTTPS 127.0.0.1:19999', certificateTrust: 'PHP 临时测试 router 为同类型 AdminGameCatalog / AdminSceneFetcher 注入仅允许 loopback 的传输并附 CA；Node 使用 NODE_EXTRA_CA_CERTS。仅测试进程配置，未修改 game 源码。', excludedRuns: 'DEBUG 关闭等环境探索不纳入主表；仅使用本轮 MySQL 证据。', lifecycle: '本地套件仅绑定 loopback，使用隔离 MySQL/Redis，不访问线上。线上只读检查、自有单行票据验证及较早 d829 验收各自列示，不合并为全部业务或供应商联调。' },
    source: { gameHead: head('../game'), wechatHead: head('.'), gameBusinessChanges: currentBusinessSourceChanges('../game', 'api'), nodeBusinessChanges: currentBusinessSourceChanges('.', 'src'), note: 'game 保持未修改的 Yii 对照；wechat HEAD 是报告生成时提交，部署应用仍为 4bcd38b，未改应用源码。实际前端 f 使用两台 Node 的 x2 上游，原 Yii 保留回滚；本轮未修改前端或旧基础设施。' },
    baseline: baseline?.comparison ?? { total: 797, matched: 676, differences: 121, note: '初始比较归档在 baseline-20261112；修复期间新增边界用例，两轮分母不同。' },
    remote: remote ?? { unavailable: true },
    candidate: candidate ?? { unavailable: true },
    productionImage: image ?? { unavailable: true },
    productionImageScope: '较早本地镜像验证归档，不是本轮未提交工作树的发布证据。',
    logicCandidateImage: logicImage ?? { unavailable: true },
    candidateSnapshotScope: '较早文件内容快照；当前工作树修改及新候选 SHA 需发布时重新锁定。',
    onlineAcceptance: onlineAcceptance(),
    dependencyAudit: { counts: dependencyAudit?.metadata?.vulnerabilities ?? null, note: '审计报告两条 high，来自同一 multer 2.4.0 公告及其 Nest 依赖链；本轮源码未注册 multer 或 multipart 文件上传中间件。此次未升级依赖，详情见 dependency-audit.json。' },
    documentedAdaptations: diagnosticAdaptations.map(row => ({ suite: row.suite, id: row.id, reason: '保留原有诊断凭据脱敏；Yii 回显 Bearer，Node 返回 [redacted]。未将此项改成一致，也未恢复凭据回显。' })),
    routeInventory: inventory ?? { unavailable: true },
    comparison: { total: primaryCases.length, matched: primaryCases.filter(row => row.equal).length, differences: primaryCases.filter(row => !row.equal).length, primarySuites: primarySuiteNames, supplemental: { total: supplementalCases.length, matched: supplementalCases.filter(row => row.equal).length, differences: supplementalCases.filter(row => !row.equal).length }, remaining: remaining.map(row => ({ suite: row.suite, id: row.id, paths: row.differences.map(change => change.path) })), note: '主对照只汇总六个 HTTP 套件，令牌互通、支付配置与原 SDK 对照额外列示。跨套件和同一根因可能重复出现，不等于独立接口数、独立 Bug 数或业务成功率。' },
    suites,
    tests: {
      node: { total: node.numTotalTests ?? null, passed: node.numPassedTests ?? null, failed: node.numFailedTests ?? null, pending: node.numPendingTests ?? null, success: node.success === true },
      yii: { unit: yii.unitOutcome ?? null, unitAligned: yii.unitAlignedOutcome ?? null, functional: yii.functionalOutcome ?? null, migrations: yii.migrationOutcome ?? null, sourceModified: yii.sourceModified ?? null, notes: yii.notes ?? [] },
      adminEs256: { tested: Boolean(adminInterop), accepted: adminInterop?.equal === true },
      businessHs256: {
        yiiToNode: { attempts: forward.length, immediateAccepted: forward.filter((row: any) => row.immediatePeerStatus === 200).length, immediate401: forward.filter((row: any) => row.immediatePeerStatus === 401).length, delayedAccepted: forward.filter((row: any) => row.delayedPeerStatus === 200).length },
        nodeToYii: { attempts: reverse.length, immediateAccepted: reverse.filter((row: any) => row.immediatePeerStatus === 200).length },
      },
    },
    boundaries: [
      `${suiteCount('anonymous')?.total ?? '待生成'} 个匿名与 ${suiteCount('authenticated')?.total ?? '待生成'} 个认证用例主要核对路由解析、方法、鉴权和前置错误；不是每条接口的有效成功输入、全部字段与完整副作用验证。`,
      '本地主对照使用合成密码材料与替身传输。较早线上供应商探测已使用现有配置完成支付材料布尔检查、实际短效 STS 签发及缺失对象 HEAD；真实微信登录/手机号、付款/退款/回调、COS PUT/GET/DELETE 和实体设备仍未执行，已按用户决定延期。',
      'Y1 场景使用本地 HTTPS 替身；并非真实 Y1 部署或网络验收。场景套件结果始终取最后一次已生成 JSON，不沿用早期证书信任配置错误。',
      '按用户要求，以现有 Yii 为兼容合同，不新增业务规则。旧入口的公开错误和保存副作用亦参与对照；诊断内容中的凭据保持脱敏，涉及扩大云存储权限的差异须单独评估。',
      '生成时钟、随机凭据、等义 Link token 引号及私有 PHP 文件路径/堆栈只按脚本中显式规则归一化；错误状态、公开消息与类型、业务余额、SQL/Redis 副作用和字段缺失继续作为证据。',
      '实际 f 前端的管理 API 按 50%/50% 分到两个 x2 上游并互为 backup；小程序网关以同两台为主/备，公共 Host/SNI 为 x2.b0.01xr.com，TLS 验证开启。两个域名的不同服务器及固定代理路径已核实；每台 Node 未来部署均需保留两个 x2 别名。撤回此前“未使用 Node”的假设，不推断历史流量。',
      'b1 当前容器 2ff62e 于上海时间 11 月 12 日 23:57:58 创建，应用仍为 4bcd38b。此前复制其 Yii 的废弃 checkin.voxel.cn origin 是配置错误，已告知用户并恢复 Node 原有 c.4mr.cn；当前与 Yii 为 23/24，唯一差异是获明确要求的退役 origin 例外。',
      '两台实际 Node 的 MySQL 实例/数据库及票据表、业务/管理 Redis 实例与 DB、六个密钥文件及管理 issuer 已核实一致，只记录布尔结论，不输出私有身份指纹。原 Yii 保留回滚，未执行 DDL、迁移、完整 Stack 重部署或辅助任务；最初被拒绝的多 Host 草案已在实际应用前收窄。',
      '11 月 13 日自有票据验证仅直接插入 1 行 pending，经真实前端分别走 b0/b1 共 4 次状态 GET、在 b1 取消 1 次，两端均见 cancelled。精确自有行及 owner lock 已清理，临时代码和完成的私有 ledger 已移除；不涉及其他业务数据。首次 CLIENT INFO 预检在任何数据写入前失败，修正实际 DB/INFO server 绑定后的成功运行单独记录。',
      '票据验证没有调用 HTTP 创建票据、全局清理、限流写入、批准、登录、消费、真实账号或供应商，不证明 QR 生成或真实微信批准。ledger 不能跨容器删除存活，Redis 重启也阻止自动恢复；本轮已完成清理。固定别名的目标由独立前端配置证据核实。',
      '11 月 12 日 23:44:34 的 b1 业务入口只读 11/11，以及 23:23:55 的两入口 22/22，分别保留历史时间与范围；不合并成全部接口证明。切换前交叉 x.b* Host 矩阵不是当前实际 x2 前端路由，不能据此推断当前请求走向。',
      '两端设备免签只延续原 Yii dev 的设备 refresh 鉴权分支，跳过 time/hash 和 token 格式检查，仍需 token 和唯一 uuid/id/key；JWT 及支付回调验签保持原规则。该设置不是由共用镜像自动继承。',
      'UI 快照曾意外把 ENV 值显示到工具输出，已告知用户；后续只输出名称、数量和布尔结论，实际值及密钥指纹没有写入仓库或报告。本投影不嵌入 ENV 值或密钥指纹。',
      '用户确认旧二维码、缺省/显式 v0、x.4mr.cn 和 checkin.voxel.cn 已停用，当前统一使用 c.4mr.cn。旧主线 2/12 只留历史参考，不是当前替换门槛，也不宣称旧协议透明兼容。较早 d829 fixture 24/24 及清理记录同样不继承为新候选真实业务联调。',
      '保留的实现边界包括诊断Bearer脱敏、Y1旧forward关闭TLS校验而Node继续验证、部分设备建档等错误分支的更强事务回滚，以及扫码限流Yii FileCache与Node SQL存储不共享。它们不被改写成严格零差异。',
      '业务ID/scene_id按现有INT32数据库域验证。PHP64整数超出JavaScript安全整数范围时，原始数值及JSON输出精度仍有边界；不能据本报告声称任意PHP64输入逐字节等价。',
      '诊断脱敏的已知差异保持在主表中，因此严格差分命令仍可为 exit 1；部署应用仍为 4bcd38b。补充验证提交 1bf66a3 的 CI 43244233055 verify 成功、publish 按条件跳过。本报告只离线汇总证据，不执行切换或外部联调。',
    ], findings, readErrors: errors,
    reproduction: [
      "cd '/Users/dirui/Documents/ChatGPT/打卡机/wechat'",
      'docker compose -p bujiaban-parity-mysql-20261112 -f scripts/differential/compose.yaml up -d --wait',
      'node --import tsx scripts/differential/prepare.ts --fresh',
      'npm run build',
      '# 另一终端保持运行；包括本地 HTTPS 场景替身',
      'node --import tsx scripts/differential/serve.ts',
      '# 回到第一个终端，顺序运行',
      'node --import tsx scripts/differential/run-integration.ts',
      'node --import tsx scripts/differential/run.ts',
      'node --import tsx scripts/differential/integrations-startup.ts',
      'node --import tsx scripts/differential/provider-boundaries.ts',
      'node --import tsx scripts/differential/report.ts',
    ], reproductionNote: '以上适用于重建空测试容器。--fresh 允许覆盖旧 context，但如 parity_ 测试库已经存在会拒绝，绝不 DROP。已有测试库时跳过 prepare，复用原 context。context、私钥和原始令牌不嵌入本报告。报告生成器只读取上述白名单 JSON，不访问数据库。',
  };
}

const clientScript = String.raw`
'use strict';
const model = JSON.parse(document.getElementById('report-data').textContent);
const summary = model.summary;
const cases = model.cases;
const $ = id => document.getElementById(id);
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function showDate(value) {
  if (!value) return '尚未生成';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'medium', hour12: false }).format(new Date(value));
}
function pretty(value) { return value === undefined ? '本项无该侧对象；请查看补充证据。' : JSON.stringify(value, null, 2); }
function appendText(parent, tag, text, className) { const node = element(tag, text, className); parent.append(node); return node; }
$('generated').textContent = '生成时间 ' + showDate(summary.generatedAt) + ' · 仅 ' + summary.database + ' · 本地隔离验证';
$('conclusion').textContent = summary.conclusion;
const metrics = [
  ['Node 自动测试', String(summary.tests.node.passed ?? '—') + ' / ' + String(summary.tests.node.total ?? '—'), '通过原测试不等于跨实现一致', summary.tests.node.success ? 'good' : 'bad'],
  ['主对照用例组', summary.comparison.matched + ' / ' + summary.comparison.total, summary.comparison.differences + ' 组仍有差异 · 非业务成功率', summary.comparison.differences ? 'bad' : 'good'],
  ['路由结构清单', summary.routeInventory.resolvable ?? '—', (summary.routeInventory.declaredMethodPaths ?? '—') + ' 项声明 · ' + (summary.routeInventory.businessAndRest ?? '—') + ' 项业务 / REST', 'neutral'],
  ['原 P1 问题未对齐', summary.findings.filter(item => item.priority === 'P1' && item.confirmed).length, '本地代码复核 · 外部联调已延期', summary.findings.some(item => item.priority === 'P1' && item.confirmed) ? 'bad' : 'good'],
];
for (const metric of metrics) {
  const card = element('article', undefined, 'metric ' + metric[3]);
  appendText(card, 'p', metric[0], 'eyebrow'); appendText(card, 'strong', metric[1]); appendText(card, 'p', metric[2], 'muted'); $('metrics').append(card);
}
for (const note of summary.boundaries) appendText($('boundaries'), 'li', note);
for (const issue of summary.findings) {
  const card = element('article', undefined, 'finding');
  const label = element('div', undefined, 'finding-title');
  appendText(label, 'span', issue.confirmed ? issue.priority : '已对齐', 'badge ' + (issue.confirmed ? issue.priority === 'P1' ? 'bad' : 'warn' : 'good'));
  appendText(label, 'h3', issue.title); card.append(label);
  appendText(card, 'p', issue.detail);
  appendText(card, 'p', (issue.confirmed ? '本轮仍有差异' : '本轮已生成证据未再报告此差异') + ' · ' + issue.evidence.join('；'), 'evidence');
  $('findings').append(card);
}
for (const suite of summary.suites) {
  const row = element('tr');
  const title = element('td', suite.label); appendText(title, 'small', suite.id + '.json', 'muted block'); row.append(title);
  if (suite.kind === 'tests') {
    let detail;
    if (suite.id === 'integration-mysql') detail = String(summary.tests.node.passed ?? '—') + '/' + String(summary.tests.node.total ?? '—') + ' 测试通过';
    else {
      const yii = summary.tests.yii;
      detail = String(yii.unitAligned?.tests ?? yii.unit?.uniqueUnitCasesPassingAfterEnvironmentAlignment ?? '—') + ' unit；' + String(yii.unitAligned?.failures ?? '—') + ' 失败；' + String(yii.functional?.tests ?? '—') + ' functional；' + String(yii.migrations?.applied ?? '—') + ' 迁移';
    }
    const cell = element('td', detail); cell.colSpan = 4; row.append(cell);
  } else for (const value of [suite.total, suite.matched, suite.differences, suite.harnessErrors]) row.append(element('td', value ?? '—'));
  row.append(element('td', suite.available ? showDate(suite.generatedAt) : '缺少报告'));
  $('suite-rows').append(row);
}
const yii = summary.tests.yii;
$('yii-note').textContent = yii.unitAligned ? 'Yii issuer 对齐后的单次完整 unit 运行：' + yii.unitAligned.tests + ' tests，' + yii.unitAligned.failures + ' failures，' + yii.unitAligned.errors + ' errors，' + yii.unitAligned.assertions + ' assertions，exit code ' + yii.unitAligned.exitCode + '。Functional：' + String(yii.functional?.tests ?? '—') + ' tests / ' + String(yii.functional?.assertions ?? '—') + ' assertions，失败 ' + String(yii.functional?.failures ?? '—') + '；迁移 ' + String(yii.migrations?.applied ?? '—') + ' 个、exit code ' + String(yii.migrations?.exitCode ?? '—') + '。初轮测试因固定 issuer 与首次环境不一致出现 ' + String(yii.unit?.initialFailures ?? '—') + ' 个失败，已保留探索记录，未修改业务源码。' : '尚无 issuer 对齐后的完整 unit 运行摘要；请查验原始 Yii 测试汇总。';
const admin = summary.tests.adminEs256;
const interop = summary.tests.businessHs256;
$('interop-note').textContent = '管理 ES256 跨实现：' + (admin.tested ? admin.accepted ? '已通过' : '有差异' : '尚无报告') + '。业务 HS256：Yii → Node 立即 ' + interop.yiiToNode.immediateAccepted + '/' + interop.yiiToNode.attempts + ' 接受，401 为 ' + interop.yiiToNode.immediate401 + ' 次，延迟后 ' + interop.yiiToNode.delayedAccepted + ' 次接受；Node → Yii 立即 ' + interop.nodeToYii.immediateAccepted + '/' + interop.nodeToYii.attempts + ' 接受。';
$('source-heads').textContent = 'game: ' + summary.source.gameHead + '\nwechat: ' + summary.source.wechatHead + '\n' + summary.source.note + '\n业务源码 Git 状态：' + (summary.source.gameBusinessChanges.length || summary.source.nodeBusinessChanges.length ? '存在变动，请检查 summary.json' : '未改动');
$('environment').textContent = summary.database + ' · @@time_zone=' + summary.environment.mysqlSessionTimeZone + ' · system_time_zone=' + summary.environment.mysqlSystemTimeZone + ' · 两端连接 charset=' + summary.environment.connectionCharset + '\nYii ENV=' + summary.environment.yiiEnvironment + ' / DEBUG=' + summary.environment.phpDebug + '\nY1: ' + summary.environment.y1Fixture + '\n' + summary.environment.certificateTrust + '\n' + summary.environment.excludedRuns + '\n' + summary.environment.lifecycle;
$('candidate').textContent = JSON.stringify({ currentLocalLogicImage: summary.logicCandidateImage, earlierSourceSnapshot: summary.candidate, snapshotScope: summary.candidateSnapshotScope, earlierLocalProductionImage: summary.productionImage, earlierImageScope: summary.productionImageScope }, null, 2);
$('remote').textContent = JSON.stringify({ onlineAcceptance: summary.onlineAcceptance, earlierReadOnlySnapshot: summary.remote }, null, 2);
$('dependency-audit').textContent = summary.dependencyAudit.note;
$('commands').textContent = summary.reproduction.join('\n');
$('reproduction-note').textContent = summary.reproductionNote;
if (summary.readErrors.length) {
  $('read-errors').hidden = false;
  $('read-errors').textContent = '以下证据未能读取，不能视为通过：' + summary.readErrors.map(item => item.source + '（' + item.message + '）').join('；');
}
const suiteSelect = $('suite');
for (const suite of summary.suites.filter(item => item.kind !== 'tests')) {
  const option = element('option', suite.label); option.value = suite.id; suiteSelect.append(option);
}
let currentPage = 1;
const pageSize = 40;
function renderCase(item) {
  const details = element('details', undefined, 'case');
  const heading = element('summary');
  appendText(heading, 'span', item.equal ? '一致' : '不同', 'badge ' + (item.equal ? 'good' : 'bad'));
  appendText(heading, 'span', item.id, 'case-id');
  appendText(heading, 'span', item.suiteLabel, 'suite-label'); details.append(heading);
  let loaded = false;
  details.addEventListener('toggle', function () {
    if (!details.open || loaded) return;
    loaded = true;
    const content = element('div', undefined, 'case-content');
    if (item.note) appendText(content, 'p', item.note, 'muted');
    if (item.differences.length) {
      const differences = element('div', undefined, 'difference-paths');
      appendText(differences, 'strong', '差异字段（missing 表示字段缺失）');
      const list = element('ul');
      for (const change of item.differences.slice(0, 80)) appendText(list, 'li', change.path);
      if (item.differences.length > 80) appendText(list, 'li', '其余 ' + (item.differences.length - 80) + ' 个字段请查看完整两侧证据。');
      differences.append(list); content.append(differences);
    }
    const grid = element('div', undefined, 'evidence-grid');
    for (const pair of [['Yii', item.yii], ['Node', item.node]]) {
      const panel = element('section', undefined, 'evidence-panel'); appendText(panel, 'h4', pair[0]); appendText(panel, 'pre', pretty(pair[1])); grid.append(panel);
    }
    content.append(grid);
    if (item.evidence) { appendText(content, 'h4', '补充原始证据'); appendText(content, 'pre', pretty(item.evidence)); }
    details.append(content);
  });
  return details;
}
function render() {
  const query = $('search').value.trim().toLocaleLowerCase('zh-CN');
  const status = $('status').value;
  const suite = suiteSelect.value;
  const filtered = cases.filter(item => (!suite || item.suite === suite) && (status === 'all' || (status === 'different' ? !item.equal : item.equal)) && (!query || (item.id + ' ' + item.suiteLabel + ' ' + (item.note || '') + ' ' + JSON.stringify(item.differences)).toLocaleLowerCase('zh-CN').includes(query)));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize)); currentPage = Math.min(currentPage, pages);
  $('cases').replaceChildren();
  for (const item of filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)) $('cases').append(renderCase(item));
  if (!filtered.length) appendText($('cases'), 'p', '没有符合筛选条件的用例。', 'empty');
  $('filter-count').textContent = '筛选出 ' + filtered.length + ' / ' + cases.length + ' 组（含补充验证）· 第 ' + currentPage + ' / ' + pages + ' 页';
  $('previous').disabled = currentPage <= 1; $('next').disabled = currentPage >= pages;
}
for (const id of ['search', 'status', 'suite']) $(id).addEventListener(id === 'search' ? 'input' : 'change', function () { currentPage = 1; render(); });
$('previous').addEventListener('click', function () { currentPage -= 1; render(); });
$('next').addEventListener('click', function () { currentPage += 1; render(); });
render();
`;

function html(summary: ObjectRow, cases: ComparisonCase[]): string {
  // Escaping '<' prevents an evidence string from terminating the JSON script.
  // All later evidence rendering uses textContent, never innerHTML.
  const payload = JSON.stringify({ summary, cases }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Yii → Node 迁移对应性报告</title>
<style>
:root{--ink:#14212e;--muted:#526270;--line:#dce3e8;--paper:#f4f6f8;--red:#a52932;--red-bg:#fff0f0;--green:#17664f;--green-bg:#e9f7ef;--amber:#8a5b10;--amber-bg:#fff5dd;--accent:#245c95}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:15px;line-height:1.65}main{max-width:1280px;margin:auto;padding:36px 28px 64px}h1{font-size:clamp(27px,4vw,38px);line-height:1.25;letter-spacing:-.035em;margin:8px 0 12px}h2{font-size:22px;line-height:1.4;margin:0 0 15px}h3{font-size:16px;margin:0}h4{font-size:14px;margin:0 0 8px}p{margin:8px 0}.eyebrow{font-size:12px;letter-spacing:.08em;color:var(--muted);font-weight:700}.muted{color:var(--muted);font-size:13px}.block{display:block}.hero{padding-bottom:24px}.conclusion{max-width:950px;font-size:18px;font-weight:600;color:var(--red)}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:0 0 26px}.metric,.section{background:white;border:1px solid var(--line);border-radius:12px}.metric{padding:16px 19px}.metric strong{font-size:31px;letter-spacing:-.04em}.metric p:last-child{margin-bottom:0}.metric.bad strong{color:var(--red)}.metric.good strong{color:var(--green)}.section{padding:25px;margin:20px 0}.scope-list{margin:0;padding-left:22px}.scope-list li{margin:10px 0}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:12px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-weight:600;color:var(--muted);white-space:nowrap}tbody tr:last-child td{border:0}.findings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.finding{padding:16px;border:1px solid var(--line);border-radius:9px;background:#fcfdfe}.finding-title{display:flex;gap:10px;align-items:flex-start}.finding p{font-size:13px}.evidence{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px!important;color:var(--muted);overflow-wrap:anywhere}.badge{display:inline-block;flex:0 0 auto;border-radius:5px;padding:2px 7px;font-weight:700;font-size:11px;line-height:1.7}.badge.bad{background:var(--red-bg);color:var(--red)}.badge.good{background:var(--green-bg);color:var(--green)}.badge.warn{background:var(--amber-bg);color:var(--amber)}.toolbar{display:grid;grid-template-columns:minmax(240px,1fr) 150px 240px;gap:12px;padding:16px;background:#edf2f6;border-radius:9px;margin-bottom:12px}.toolbar label{font-size:12px;color:var(--muted);font-weight:600;display:flex;flex-direction:column;gap:5px}input,select,button{font:inherit;border:1px solid #bac8d2;border-radius:6px;background:white;color:var(--ink);padding:8px 10px;min-height:39px}input:focus,select:focus,button:focus-visible,summary:focus-visible{outline:3px solid #b4d7fa;outline-offset:2px}.pager{display:flex;align-items:center;gap:9px;justify-content:flex-end;margin:15px 0}.pager .muted{margin-right:auto}button{cursor:pointer;font-size:12px}button:disabled{opacity:.45;cursor:default}.case{border:1px solid var(--line);border-radius:8px;margin:8px 0;background:white}.case>summary{cursor:pointer;display:flex;align-items:center;gap:10px;padding:13px 15px;list-style:none}.case>summary::-webkit-details-marker{display:none}.case>summary:before{content:'›';font-weight:700;color:var(--muted);width:12px;flex:0 0 12px}.case[open]>summary:before{transform:rotate(90deg)}.case-id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;overflow-wrap:anywhere}.suite-label{margin-left:auto;white-space:nowrap;font-size:11px;color:var(--muted)}.case-content{border-top:1px solid var(--line);padding:17px;background:#f9fbfc}.evidence-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.evidence-panel{min-width:0}pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;background:#eef2f5;border:1px solid #dde5eb;border-radius:7px;padding:14px;font-size:11px;line-height:1.65;margin:0 0 12px;max-height:650px;overflow:auto}.difference-paths{font-size:12px;margin:0 0 16px}.difference-paths ul{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;margin:7px 0;padding-left:20px;max-height:160px;overflow:auto}.empty{text-align:center;padding:25px;color:var(--muted)}.notice{padding:12px 16px;border:1px solid #efc8ca;border-radius:8px;background:var(--red-bg);color:var(--red);margin-top:15px}footer{font-size:12px;color:var(--muted);margin-top:25px}@media(max-width:900px){.metrics{grid-template-columns:repeat(2,1fr)}.findings{grid-template-columns:1fr}.toolbar{grid-template-columns:1fr 1fr}.toolbar label:first-child{grid-column:1/-1}.suite-label{display:none}}@media(max-width:600px){main{padding:22px 14px 40px}.section{padding:17px}.metrics{gap:9px}.metric{padding:12px}.metric strong{font-size:26px}.evidence-grid{grid-template-columns:1fr}.toolbar{grid-template-columns:1fr}.toolbar label:first-child{grid-column:auto}.case>summary{padding:11px 9px;gap:7px}}
</style></head><body><main>
<header class="hero"><p class="eyebrow">BUJIABAN · LOCAL IMPLEMENTATION COMPARISON</p><h1>Yii → Node 迁移对应性报告</h1><p id="conclusion" class="conclusion"></p><p id="generated" class="muted"></p><div id="read-errors" class="notice" hidden></div></header>
<div id="metrics" class="metrics" aria-label="验证概览"></div>
<section class="section"><h2>结论的适用范围</h2><ul id="boundaries" class="scope-list"></ul><p class="muted">路由声明、可解析 action、自动测试断言和真实业务流程是不同维度，下面分别列示。主表条目会重复同一路由或同一根因，不等于独立 Bug 数量，也不合并成“全部接口通过率”。互通和配置构造验证额外列示。</p></section>
<section class="section"><h2>已复现差异与优先级</h2><div id="findings" class="findings"></div></section>
<section class="section"><h2>本轮执行结果</h2><div class="table-wrap"><table><thead><tr><th>证据套件</th><th>用例组</th><th>一致</th><th>不同</th><th>测试工具错误</th><th>最后生成时间（上海）</th></tr></thead><tbody id="suite-rows"></tbody></table></div><p id="yii-note" class="muted"></p><p id="interop-note" class="muted"></p></section>
<section class="section"><h2>逐项对照证据</h2><p class="muted">默认只显示不同项。展开可查看 Yii 与 Node 的响应、SQL / Redis 状态；凭据和字面令牌已脱敏。搜索支持用例名、路径及差异字段。</p><div class="toolbar"><label>搜索用例或差异字段<input id="search" type="search" placeholder="例如 points、cache-control、updated_at" autocomplete="off"></label><label>对照结果<select id="status"><option value="different" selected>只看不同</option><option value="all">全部用例</option><option value="matched">只看一致</option></select></label><label>证据套件<select id="suite"><option value="">全部套件</option></select></label></div><div class="pager"><span id="filter-count" class="muted" aria-live="polite"></span><button id="previous" type="button">上一页</button><button id="next" type="button">下一页</button></div><div id="cases"></div></section>
<section class="section"><h2>当前本地代码、部署状态与历史候选</h2><pre id="candidate"></pre><pre id="remote"></pre><p id="dependency-audit" class="muted"></p></section>
<section class="section"><h2>比较基线与复现</h2><pre id="source-heads"></pre><pre id="environment"></pre><pre id="commands"></pre><p id="reproduction-note" class="muted"></p></section>
<footer>这是可离线打开的单文件报告，不加载外部脚本、字体或服务。原始证据以生成时快照嵌入；重新执行报告生成器即可读取最新 JSON。</footer>
</main><script id="report-data" type="application/json">${payload}</script><script>${clientScript}</script></body></html>`;
}

function main(): void {
  const { evidence, errors } = readEvidence();
  const cases = casesFromEvidence(evidence);
  const summary = sanitize(buildSummary(evidence, cases, errors));
  writeFileSync(resolve(directory, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(resolve(directory, 'report.html'), html(summary, sanitize(cases)));
  console.log(JSON.stringify({ report: resolve(directory, 'report.html'), summary: resolve(directory, 'summary.json'), caseGroups: summary.comparison.total, matched: summary.comparison.matched, differences: summary.comparison.differences, missingEvidence: errors.length }));
}

main();
