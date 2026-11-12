#!/usr/bin/env python3
"""Replay pure local old-main source cases. Opens no application services."""
import hashlib
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
ORACLE = ROOT / 'scripts/legacy-differential/old-main-oracle.php'
HERE = ROOT / 'runtime/legacy-main-source-20261112'
if not __debug__:
    raise RuntimeError('Run this checker without Python optimization (-O)')
preparation = subprocess.run([sys.executable, str(ROOT / 'scripts/legacy-differential/prepare-source.py')],
                             text=True, capture_output=True, cwd=str(ROOT))
if preparation.returncode != 0:
    raise RuntimeError('Frozen source preparation failed: ' + preparation.stderr.strip())
prepared = json.loads(preparation.stdout)
ORDER = {'openid': 'synthetic-old-client-openid', 'out_trade_no': 'old_client_order_001', 'amount': 123}
cases = []


def add(name, operation, body=None, query=None, provider=None, **extra):
    data = {'operation': operation, **extra}
    if body is not None:
        data['body'] = body
    if query is not None:
        data['query'] = query
    if provider is not None:
        data['provider'] = provider
    cases.append({'name': name, 'input': data})


add('payment-old-client-missing-file-id', 'payment-order-v2', body=ORDER)
add('payment-default-description', 'payment-order-v2', body=ORDER)
add('payment-missing-openid', 'payment-order-v2', body={k: v for k, v in ORDER.items() if k != 'openid'})
add('payment-missing-order-number', 'payment-order-v2', body={k: v for k, v in ORDER.items() if k != 'out_trade_no'})
add('payment-zero-amount', 'payment-order-v2', body={**ORDER, 'amount': 0})
add('payment-zero-string-amount', 'payment-order-v2', body={**ORDER, 'amount': '0'})
add('payment-invalid-amount', 'payment-order-v2', body={**ORDER, 'amount': 'invalid'})
add('payment-short-order-number', 'payment-order-v2', body={**ORDER, 'out_trade_no': 'short'})
add('payment-negative-amount-source-behavior', 'payment-order-v2', body={**ORDER, 'amount': -1})
add('payment-fraction-truncation-source-behavior', 'payment-order-v2', body={**ORDER, 'amount': '123.9'})
add('payment-provider-missing-prepay', 'payment-order-v2', body=ORDER, provider={'body': {'code': 'FAIL'}})
add('payment-provider-exception', 'payment-order-v2', body=ORDER, provider={'throw': 'synthetic failure'})
add('payment-query-missing-order-number', 'payment-query-v2', query={})
add('payment-query-success', 'payment-query-v2', query={'out_trade_no': ORDER['out_trade_no']}, provider={'body': {'trade_state': 'SUCCESS'}})
add('payment-query-provider-error-body', 'payment-query-v2', query={'out_trade_no': ORDER['out_trade_no']}, provider={'body': {'code': 'ORDER_NOT_EXIST'}})
add('refund-too-large', 'payment-refund-v2', body={'out_trade_no': ORDER['out_trade_no'], 'out_refund_no': 'refund001', 'refund_amount': 124, 'total_amount': 123})
add('refund-positive', 'payment-refund-v2', body={'out_trade_no': ORDER['out_trade_no'], 'out_refund_no': 'refund001', 'refund_amount': '12.5', 'total_amount': 123}, provider={'body': {'refund_id': 'synthetic-refund', 'status': 'PROCESSING', 'amount': {'refund': 12}}})
add('transaction-query-invalid-id', 'payment-query-transaction-v2', query={'transaction_id': 'short'})
add('transaction-query-success', 'payment-query-transaction-v2', query={'transaction_id': '1' * 28}, provider={'body': {'trade_state': 'SUCCESS', 'transaction_id': '1' * 28}})
add('token-without-domain', 'user-token', userId=17)
files = [{'id': i, 'unionid': 'fixture-union' if i % 2 else 'prefix-fixture-union-suffix', 'key': 'synthetic/file-%s.mp4' % i, 'unlocked': i % 2} for i in range(1, 26)]
files.append({'id': 100, 'unionid': 'different-union', 'key': 'synthetic/other.mp4'})
add('file-list-like-default-page', 'file-list', query={'unionid': 'fixture-union'}, files=files)
add('file-list-second-page', 'file-list', query={'unionid': 'fixture-union', 'page': 2}, files=files)
add('file-list-custom-page-size', 'file-list', query={'unionid': 'fixture-union', 'page': 2, 'per-page': 2}, files=files)
add('file-list-source-sort', 'file-list', query={'unionid': 'fixture-union', 'sort': '-id', 'per-page': 2}, files=files)
add('file-list-empty-union-source-behavior', 'file-list', query={'unionid': ''}, files=files)
add('file-list-no-match', 'file-list', query={'unionid': 'does-not-exist'}, files=files)
add('file-list-required-union', 'file-list', query={}, files=files)

results = []
for case in cases:
    process = subprocess.run(['php', str(ORACLE)], input=json.dumps(case['input']), text=True, capture_output=True, cwd=str(ROOT))
    assert process.returncode == 0 and not process.stderr, (case['name'], process.returncode, process.stderr)
    output = json.loads(process.stdout)
    assert output['sourceCommit'] == 'c4e088adc7ba17bd5bb640ac31178a122906e002'
    assert output['isolation']['applicationConfigLoaded'] is False
    for source in output['executedSource']:
        path = HERE / 'source/api' / source['path']
        assert hashlib.sha256(path.read_bytes()).hexdigest() == source['sha256']
    results.append({**case, 'output': output})

by_name = {x['name']: x['output'] for x in results}
def value(name):
    return by_name[name]['result']['body']
def total(name):
    return by_name[name]['transportCalls'][0]['options']['json']['amount']['total']

for result in results:
    expected_status = 400 if result['name'] == 'file-list-required-union' else 200
    assert result['output']['result']['status'] == expected_status, result['name']
for name in ['payment-old-client-missing-file-id', 'payment-default-description', 'payment-negative-amount-source-behavior', 'payment-fraction-truncation-source-behavior']:
    assert value(name)['code'] == 0
    request = by_name[name]['transportCalls'][0]
    assert request['path'] == 'v3/pay/transactions/jsapi'
    assert set(request['options']['json']) == {'appid', 'mchid', 'description', 'out_trade_no', 'notify_url', 'amount', 'payer'}
    assert request['options']['json']['notify_url'] == 'https://old-main.fixture.invalid/v1/wechat-pay/notify'
assert by_name['payment-default-description']['transportCalls'][0]['options']['json']['description'] == '商品支付'
assert total('payment-negative-amount-source-behavior') == -1
assert total('payment-fraction-truncation-source-behavior') == 123
for name in ['payment-missing-openid', 'payment-missing-order-number', 'payment-zero-amount', 'payment-zero-string-amount', 'payment-invalid-amount', 'payment-short-order-number', 'payment-query-missing-order-number', 'refund-too-large', 'transaction-query-invalid-id']:
    assert value(name)['code'] == 400 and by_name[name]['transportCalls'] == [], name
for name in ['payment-provider-missing-prepay', 'payment-provider-exception']:
    assert value(name)['code'] == 500 and len(by_name[name]['transportCalls']) == 1
assert value('payment-query-success')['data']['trade_state'] == 'SUCCESS'
assert value('payment-query-provider-error-body')['code'] == 0
assert value('payment-query-provider-error-body')['data']['order_info']['code'] == 'ORDER_NOT_EXIST'
assert value('refund-positive')['data']['refund_amount'] == 12
assert value('transaction-query-success')['data']['transaction_id'] == '1' * 28
claims = value('token-without-domain')['claims']
assert set(claims) == {'iss', 'iat', 'nbf', 'exp', 'uid'}
assert claims['uid'] == 17 and claims['exp'] - claims['iat'] == 10800
assert [f['id'] for f in value('file-list-like-default-page')] == list(range(1, 21))
assert [f['id'] for f in value('file-list-second-page')] == list(range(21, 26))
assert [f['id'] for f in value('file-list-custom-page-size')] == [3, 4]
assert [f['id'] for f in value('file-list-source-sort')] == [25, 24]
assert len(value('file-list-empty-union-source-behavior')) == 20
assert value('file-list-no-match') == []
assert value('file-list-required-union')['message'] == 'Missing required parameters: unionid'
assert by_name['file-list-required-union']['executedSource'] == []
assert by_name['file-list-like-default-page']['persistenceCalls'][0]['where'] == ['like', 'unionid', 'fixture-union']
assert set(value('file-list-like-default-page')[0]) == {'id', 'unionid', 'key', 'type', 'md5', 'size', 'bucket', 'created_at', 'unlocked', 'title', 'user_id'}

(HERE / 'oracle-fixtures.json').write_text(json.dumps(cases, indent=2, ensure_ascii=False) + '\n')
(HERE / 'oracle-results.json').write_text(json.dumps({'passed': len(results), 'results': results}, indent=2, ensure_ascii=False) + '\n')
print(json.dumps({'passed': len(results), 'sourceCommit': 'c4e088adc7ba17bd5bb640ac31178a122906e002', 'results': str(HERE / 'oracle-results.json'), 'verifiedSourceFiles': prepared['verifiedReadOnlyFiles']}, ensure_ascii=False))
