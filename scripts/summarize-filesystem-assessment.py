"""Derive a public assessment from retained local reports; never edit raw evidence."""
import argparse, collections, hashlib, json, pathlib, re, subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
def read(p):
    return json.loads(pathlib.Path(p).read_text(encoding='utf-8-sig'))
def sha(p):
    return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def relative(p):
    return pathlib.Path(p).resolve().relative_to(ROOT).as_posix()
def counts(items):
    return dict(collections.Counter(i['status'] for i in items))

ap = argparse.ArgumentParser()
ap.add_argument('--native', nargs=3, required=True)
ap.add_argument('--applications', nargs=3, required=True)
ap.add_argument('--recovery', required=True)
ap.add_argument('--output', required=True)
ap.add_argument('--update-matrix', action='store_true')
args = ap.parse_args()
output = ROOT / args.output
report = {'date': '2026-10-16', 'productCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
          'sourcePolicy': 'Raw reports retained unchanged. Outcome parsers corrected from original logs, never by rerunning a failed assertion.',
          'engineSha256': sha(ROOT/'engines/juicefs.exe'), 'rcloneSha256': sha(ROOT/'engines/rclone.exe'),
          'native': [], 'applications': [], 'recovery': {}, 'reused': []}
executions = []
def execution(run, case_id, case, suite, target, status, seconds, evidence, detail='', profile=''):
    executions.append({'run': run, 'id': case_id, 'case': case, 'suite': suite, 'target': target, 'date': report['date'],
        'status': {'passed':'已通过','failed':'已失败','timeout':'已超时'}[status], 'seconds': seconds,
        'profile': profile, 'version': 'JuiceFS 1.3.0+30190ca / WinFsp 2.1.25156; fork tool testing_suit_20250324 where applicable',
        'backend': 'NTFS' if target == 'ntfs' else '本地后端', 'mode': '后台' if 'writeback' in target else '不适用' if target == 'ntfs' else '同步',
        'commit': report['productCommit'], 'evidence': evidence, 'detail': detail})

for name in args.native:
    folder = ROOT/name; raw = read(folder/'report.json')
    assert raw.get('completed') and not raw.get('sessionsRetained')
    group = {'target': raw['target'], 'evidence': relative(folder/'report.json'), 'reportSha256': sha(folder/'report.json'),
             'nativeToolSha256': raw['nativeToolSha256'], 'safelyUnmounted': raw.get('safelyUnmounted'), 'cases': []}
    for c in raw['cases']:
        log = (folder/c['log']).read_text(encoding='utf8', errors='replace')
        outcome = c['status']; correction = None
        if c['id'].startswith('WFP-OPT-'):
            passed = c.get('exitCode') == 0 and not c.get('error') and '--- COMPLETE ---' in log and re.search('^'+re.escape(c['title'])+r'[.\s]+OK [\d.]+s\r?$', log, re.M)
            outcome = 'timeout' if c.get('timedOut') else 'passed' if passed else 'failed'
            correction = 'Native output pads case names with dots, not whitespace.'
        elif c['id'] == 'JFS-SMOKE-02' and c.get('exitCode') == 0:
            data = json.JSONDecoder().raw_decode(log[log.index('{'):])[0]
            outcome = 'passed' if data.get('Setting') and data.get('Sessions') else 'failed'
            correction = 'Parse stdout JSON independently of stderr diagnostic timestamps.'
        elif c['id'] == 'JFS-SMOKE-04' and c.get('exitCode') == 0:
            outcome = 'passed' if re.search(r'^\|\s*/\s*\|[^|]+\|\s*1\s*\|\s*2\s*\|', log, re.M) and '1.txt' in log and '2.txt' in log else 'failed'
            correction = 'summary reports allocated space; validate one directory and two files, not logical byte count.'
        assert outcome in ('passed','failed','timeout')
        item = {k:c[k] for k in ('id','title','args','exitCode','seconds')}
        item.update(status=outcome, log=relative(folder/c['log']), logSha256=sha(folder/c['log']))
        if c['status'] != outcome:
            item.update(initialHarnessStatus=c['status'], parserCorrection=correction)
        if outcome != 'passed':
            item['failure'] = [line for line in log.splitlines() if re.search(r'ASSERT|EXCEPTION|<FATAL>|\bKO\b', line)][:8]
            if c['id']=='JFS-SMOKE-03' and 'wmic' in log: item['classification']='environment dependency: wmic unavailable'
        group['cases'].append(item)
        execution('GAPS-20261016-'+raw['target'], c['id'], c['title'], 'winfsp-fork-optional' if c['id'].startswith('WFP') else 'juicefs-cli-smoke', raw['target'], outcome, c['seconds'], item['log'], ' '.join(item.get('failure', [])), ' '.join(c['args']))
    group['nativeCounts']=counts([c for c in group['cases'] if c['id'].startswith('WFP')])
    group['cliCounts']=counts([c for c in group['cases'] if c['id'].startswith('JFS')])
    report['native'].append(group)

for name in args.applications:
    folder=ROOT/name; initial=read(folder/'report.json'); followup=read(folder/'followup-report.json'); manifest=read(folder/'manifest.json')
    assert initial['passed'] is False and followup['passed'] is True and not followup.get('sessionsRetained')
    assert len(manifest['files'])==1002
    group={'target': initial['mode'], 'initialEvidence': relative(folder/'report.json'), 'followupEvidence': relative(folder/'followup-report.json'),
        'initialReportSha256':sha(folder/'report.json'),'followupReportSha256':sha(folder/'followup-report.json'),
        'manifestSha256':sha(folder/'manifest.json'),'checks':manifest['checks'],'coldFilesVerified':len(manifest['files']),
        'sparseLogicalBytes':5*1024**3+1173,'initialOutcome':'failed','followupOutcome':'passed',
        'concurrentReplace':'EPERM on NTFS and both JuiceFS modes; retained as a failed strict workload, not attributed to JuiceFS alone',
        'safelyUnmounted':followup.get('safelyUnmounted')}
    assert 'EPERM' in initial['error'] and len(manifest['checks'])==5
    report['applications'].append(group)
    mappings=[('PLAN-016','128 MiB cross-block writes'),('PLAN-016','5 GiB sparse offsets'),('PLAN-017','1000 Unicode files'),('PLAN-017','24-level directory tree'),('BASE-004','Git and editor-style atomic save')]
    for (case_id,title),detail in zip(mappings,manifest['checks']):
        execution('APPS-20261016-'+initial['mode'],case_id,title,'application-workload',initial['mode'],'passed',None,group['followupEvidence'] if case_id=='BASE-004' else relative(folder/'manifest.json'),detail)
    execution('APPS-20261016-'+initial['mode'],'PLAN-010','concurrent atomic replacement','application-workload',initial['mode'],'failed',initial['stages'][0]['seconds'],group['initialEvidence'],group['concurrentReplace'])
    execution('APPS-20261016-'+initial['mode'],'PLAN-016','cold hash verification and sparse holes','application-workload',initial['mode'],'passed',followup['stages'][-1]['seconds'],group['followupEvidence'],'1002 file hashes, sparse holes and deletion; ordinary reread on NTFS')

folder=ROOT/args.recovery; raw=read(folder/'report.json'); assert raw['passed'] and len(raw['cases'])==3
report['recovery']={'evidence':relative(folder/'report.json'),'reportSha256':sha(folder/'report.json'),'limits':raw['limits'],'cases':[]}
for c,case_id in zip(raw['cases'],['PLAN-006','PLAN-007','PLAN-001']):
    assert c['passed'] and c['safelyStopped'] and c['coldReadPassed']
    item={k:c[k] for k in ['scenario','passed','faultRequests','putRequests','droppedResponses','stagedAfterClose','coldReadPassed','safelyStopped']}
    item['matrixId']=case_id
    if 'stagedAfterCrash' in c: item['stagedAfterCrash']=c['stagedAfterCrash']
    report['recovery']['cases'].append(item)
    execution('RECOVERY-20261016',case_id,c['scenario'],'writeback-fault-recovery','juicefs-writeback','passed',None,report['recovery']['evidence'],'Local S3; --writeback; fsync/close; overwrite, rename, delete/recreate and cold hashes')

for name,scope in [
 ('docs/JUICEFS-UPSTREAM-RESULTS-2026-10-15.json','8 historical backend/mode groups; default 54-case fork suite, Python, winfstest, bounded FSX, cold reads and fsck'),
 ('docs/JUICEFS-CLOUD-RESULTS-2026-10-14.json','3 cloud backends, 2 write policies, gateway and initialization recovery'),
 ('docs/RCLONE-DIRECT-FIX-RESULTS-2026-10-10.json','Direct mode strict baseline: 68 pass, 48 fail, 1 timeout'),
 ('docs/JUICEFS-TRUNCATE-RESULTS-2026-10-15.json','Confirmed truncate-after-flush-timeout defect; not fixed'),
 ('test-results/prepush-unit.log','63 current-product unit tests passed'),
 ('test-results/cache-settings-g9qbn9/report.json','Current cache setting transition / real mount / cold read'),
 ('test-results/cache-settings-ui-final.log','Source UI / real IPC'),
 ('test-results/cache-settings-packaged-pass.log','Packaged UI / real IPC')]:
    report['reused'].append({'evidence':name,'sha256':sha(ROOT/name),'scope':scope,'kind':'historical reuse, not a new run'})
cloud=read(ROOT/'docs/JUICEFS-CLOUD-RESULTS-2026-10-14.json')
assert report['engineSha256']==cloud['juicefsSha256'] and report['rcloneSha256']==cloud['rcloneSha256']
report['reuseAudit']=read(ROOT/'test-results/comprehensive-reuse-audit.json')
report['newExecutionRecords']=len(executions)
assert len(executions)==145
report['newExecutionCounts']=dict(collections.Counter(e['status'] for e in executions))
audit=ROOT/'test-results/comprehensive-process-audit.json'
if audit.exists():
    report['shutdownAudit']=read(audit)
    assert not report['shutdownAudit']['liveOwnedProcesses'] and not report['shutdownAudit']['remainingTestMounts']

if args.update_matrix:
    matrix_path=ROOT/'docs/FILESYSTEM-TEST-MATRIX.json';matrix=read(matrix_path)
    assert len(matrix['rows'])==364 and len(matrix['executions'])==1004, 'Preserve prior updates; this import is one-time'
    matrix['scope']='Fixed-version inventory with preserved historical executions and 2026-10-16 supplemental local runs; dated Excel remains the pre-assessment archive'
    matrix['executions'].extend(executions)
    matrix['evidenceRegistry']['currentAssessment']=[['E-20261016-FULL','2026-10-16',args.output,'37 optional cases, 5 CLI commands, bounded application workloads and 3 writeback recovery faults','Historical defects and failed NTFS controls retained; partial PLAN coverage stays pending']]
    rows={r['id']:r for r in matrix['rows']}
    actual={}
    for group in report['native']:
        if group['target']!='ntfs':
            for item in group['cases']:actual.setdefault(item['id'],[]).append(item)
    severity={'passed':0,'failed':1,'timeout':2}
    for case_id,items in actual.items():
        outcome=max((c['status'] for c in items),key=severity.get)
        r=rows[case_id];r['status']={'passed':'已通过','failed':'已失败','timeout':'已超时'}[outcome]
        r['evidence']='E-20261016-FULL / '+case_id;r['current']='本轮本地后端同步／后台均执行；真实网盘未追加此变体'
        r['next']='保留本轮结果；详见 FILESYSTEM-VALIDATION-2026-10-16.md'
        if case_id=='JFS-SMOKE-03':r['next']='wmic 缺失导致 debug 退出 1；环境依赖阻塞，未算通过'
    rows['PLAN-007'].update(status='已通过',current='本轮本地后台模式：远端保存后丢弃一次响应，重试及冷读通过',evidence='E-20261016-FULL / recovery',next='继续扩展真实网盘与更多并发顺序；本轮仅证实已记录故障序列')
    partial={
      'PLAN-001':'本轮验证 fsync/关闭后、6 个暂存块尚未上传时终止客户端并恢复；其他写入阶段及整机断电未测',
      'PLAN-006':'本轮本地代理 18 次 503 后恢复通过；长期断网、反复重连和三网盘仍待测',
      'PLAN-008':'本轮后台暂存期间覆盖、改名、删除重建冷读通过；其他模式/时序待测',
      'PLAN-010':'本轮三写进程替换测试在 NTFS/两种 JuiceFS 均 EPERM；保留失败，完整共享访问/锁/截断组合仍待定义与补测',
      'PLAN-016':'本轮 128 MiB 实体数据跨块写入及 5 GiB 稀疏文件冷读通过；数 GiB 实体内容和云端长序列待测',
      'PLAN-017':'本轮 1000 文件、50 目录、24 层目录及冷读通过；更大规模/移动删除组合/云端待测',
      'BASE-004':'本轮 Git init/add/两次 commit/fsck 与模拟编辑器替换通过；checkout/锁冲突/真实编辑器待测',
      'PLAN-019':'本轮仅 Git 加模拟保存；Office/真实编辑器及崩溃保存未测'}
    for case_id,text in partial.items(): rows[case_id].update(current=text,evidence='E-20261016-FULL / applications,recovery',next='部分覆盖，维持待补充；不可把子场景通过视为整项通过')
    matrix['counts']['status']=dict(collections.Counter(r['status'] for r in matrix['rows']))
    matrix['sourceControls'].update(forkPending=0,forkOptionalExecuted=37,historicalExecutionRecords=len(matrix['executions']))
    matrix['latestAssessment']={'report':args.output,'freshExecutionRecords':145,'datedWorkbook':'FILESYSTEM-TEST-MATRIX-2026-10-16.xlsx','workbookIsPreAssessmentSnapshot':True,'pendingCases':sum(r['status'] in ('待执行','待补充') for r in matrix['rows'])}
    report['matrixCounts']=matrix['counts'];report['pending']= [{'id':r['id'],'level':r['level'],'title':r['title'],'status':r['status'],'scope':r['scope'],'remaining':r['current']} for r in matrix['rows'] if r['status'] in ('待执行','待补充')]
    matrix_path.write_text(json.dumps(matrix,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
else:
    matrix=read(ROOT/'docs/FILESYSTEM-TEST-MATRIX.json')
    report['matrixCounts']=matrix['counts']
    report['pending']=[{'id':r['id'],'level':r['level'],'title':r['title'],'status':r['status'],'scope':r['scope'],'remaining':r['current']} for r in matrix['rows'] if r['status'] in ('待执行','待补充')]
output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print(json.dumps({'output':relative(output),'freshExecutions':len(executions),'counts':report['newExecutionCounts'],'matrixStatus':report.get('matrixCounts',{}).get('status')},ensure_ascii=False))
