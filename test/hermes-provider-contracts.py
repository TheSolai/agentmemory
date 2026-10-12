import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
import unittest
from unittest.mock import patch

PLUGIN = Path(__file__).resolve().parents[1] / 'integrations/hermes/__init__.py'


class ProviderContract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        (self.home / '.agentmemory').mkdir()
        self.env = patch.dict(os.environ, {'HOME': str(self.home), 'HERMES_HOME': str(self.home / '.hermes')}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(self.temp.cleanup)

    def load(self):
        spec = importlib.util.spec_from_file_location('hermes_contract', PLUGIN)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.module = module
        return module

    def test_saved_secret_stays_on_numeric_loopback(self):
        (self.home / '.agentmemory/secret').write_text('synthetic-local-secret')
        module = self.load()
        for url in ['http://127.2.3.4', 'http://[::1]', 'https://localhost']:
            self.assertEqual(module._stored_secret(url), 'synthetic-local-secret', url)
        for url in ['https://127.example.invalid', 'https://localhost.example.invalid', 'http://192.168.1.1', 'ftp://127.0.0.1', 'http://127.0.0.1@remote.invalid']:
            self.assertEqual(module._stored_secret(url), '', url)

    def test_local_dotenv_is_not_promoted_to_explicit_remote_credentials(self):
        (self.home / '.agentmemory/.env').write_text('AGENTMEMORY_SECRET=synthetic-dotenv-secret\n')
        module = self.load()
        self.assertNotIn('AGENTMEMORY_SECRET', os.environ)
        self.assertEqual(module._stored_secret('https://remote.invalid'), '')
        self.assertEqual(module._stored_secret('http://127.0.0.1'), 'synthetic-dotenv-secret')

    def provider(self, **kwargs):
        module = self.load()
        self.calls = []
        def request(base, path, body=None, **options):
            self.calls.append((base, path, body, options))
            return {"success": True}
        module._api = request
        provider = module.AgentMemoryProvider()
        provider.initialize('old-session', cwd=str(self.home), **kwargs)
        return provider

    def test_config_precedence_and_no_saved_credential_on_url_override(self):
        profile = self.home / 'profile'
        profile.mkdir()
        (profile / 'agentmemory.json').write_text(json.dumps({'url': 'https://configured.invalid/', 'secret': 'synthetic-config-secret'}))
        os.environ['HERMES_HOME'] = str(profile)
        module = self.load()
        self.assertEqual(module._configuration(), ('https://configured.invalid', 'synthetic-config-secret'))
        self.assertTrue(module.AgentMemoryProvider().is_available())
        os.environ['AGENTMEMORY_URL'] = 'https://override.invalid'
        self.assertEqual(module._configuration(), ('https://override.invalid', ''))
        os.environ['AGENTMEMORY_SECRET'] = 'synthetic-explicit-secret'
        self.assertEqual(module._configuration(), ('https://override.invalid', 'synthetic-explicit-secret'))

    def test_config_respects_initialize_home_and_does_not_save_secrets(self):
        provider = self.provider()
        profile = self.home / 'profile'
        provider.save_config({'url': 'http://127.0.0.1:9999', 'secret': 'must-not-be-saved'}, str(profile))
        self.assertEqual(json.loads((profile / 'agentmemory.json').read_text()), {'url': 'http://127.0.0.1:9999'})
        provider.initialize('profile-session', cwd=str(self.home), hermes_home=str(profile))
        self.assertEqual(self.calls[-1][0], 'http://127.0.0.1:9999')

    def test_malformed_config_falls_back_and_invalid_explicit_url_is_unavailable(self):
        profile = self.home / '.hermes'
        profile.mkdir()
        (profile / 'agentmemory.json').write_text('{')
        module = self.load()
        self.assertEqual(module._configuration()[0], module.DEFAULT_BASE_URL)
        for value in ['[]', '{"url": false}', '{"url": 123}']:
            (profile / 'agentmemory.json').write_text(value)
            self.assertEqual(module._configuration()[0], module.DEFAULT_BASE_URL)
        os.environ['AGENTMEMORY_URL'] = 'file:///tmp/memory'
        self.assertFalse(module.AgentMemoryProvider().is_available())

    def test_dotenv_fills_url_without_mutating_environment(self):
        (self.home / '.agentmemory/.env').write_text('export AGENTMEMORY_URL="https://remote.invalid" # comment\nAGENTMEMORY_SECRET=synthetic-local-only\n')
        module = self.load()
        self.assertEqual(module._configuration(), ('https://remote.invalid', ''))
        self.assertNotIn('AGENTMEMORY_URL', os.environ)

    def test_url_delimiters_fail_closed_without_rejecting_encoded_paths(self):
        module = self.load()
        module.urlopen = lambda *a, **k: self.fail('invalid endpoint reached the network')
        for suffix in ['?', '#', '?query', '#fragment']:
            endpoint = 'http://localhost:3111/base' + suffix
            self.assertFalse(module._validate_url(endpoint), endpoint)
            self.assertEqual(module._api(endpoint, 'search')['errorCode'], 'invalid_url')
        for suffix in ['%3F', '%23']:
            self.assertTrue(module._validate_url('http://localhost:3111/base' + suffix))

    def test_plaintext_guard_uses_same_numeric_loopback_boundary(self):
        module = self.load()
        os.environ['AGENTMEMORY_REQUIRE_HTTPS'] = '1'
        for url in ['http://127.2.3.4', 'http://[::1]', 'http://localhost']:
            module._check_plaintext_bearer_guard(url, 'synthetic')
        with self.assertRaises(RuntimeError):
            module._check_plaintext_bearer_guard('http://127.example.invalid', 'synthetic')

    def test_authentication_offline_and_invalid_responses_are_distinguishable(self):
        module = self.load()
        for error, code in [(HTTPError('http://localhost', 401, 'private details', None, None), 'authentication'), (URLError('private address'), 'unavailable')]:
            module.urlopen = lambda *a, error=error, **k: (_ for _ in ()).throw(error)
            result = module._api('http://localhost', 'search', {'query': 'test'})
            self.assertFalse(result['success'])
            self.assertEqual(result['errorCode'], code)
            self.assertNotIn('private', result['error'])
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return b'[]'
        module.urlopen = lambda *a, **k: Response()
        self.assertEqual(module._api('http://localhost', 'search')['errorCode'], 'invalid_response')

    def test_endpoint_change_does_not_receive_a_different_endpoints_credentials(self):
        module = self.load()
        os.environ['AGENTMEMORY_URL'] = 'https://remote.invalid'
        seen = []
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return b'{"success":true}'
        def intercept(request, **kwargs):
            seen.append(request.get_header('Authorization'))
            return Response()
        module.urlopen = intercept
        provider = module.AgentMemoryProvider()
        provider.initialize('session', cwd=str(self.home))
        os.environ['AGENTMEMORY_SECRET'] = 'different-profile-secret'
        os.environ['AGENTMEMORY_URL'] = 'https://different.invalid'
        provider.handle_tool_call('memory_save', {'content': 'test'})
        self.assertEqual(seen, [None])

    def test_credentials_rotate_for_the_same_endpoint(self):
        module = self.load()
        secret_path = self.home / '.agentmemory/secret'
        secret_path.write_text('synthetic-first')
        calls = []
        module._api = lambda *a, **k: calls.append(k['secret']) or {'success': True}
        provider = module.AgentMemoryProvider()
        provider.initialize('session', cwd=str(self.home))
        secret_path.write_text('synthetic-second')
        provider.handle_tool_call('memory_save', {'content': 'test'})
        os.environ['AGENTMEMORY_SECRET'] = 'synthetic-third'
        provider.handle_tool_call('memory_save', {'content': 'test'})
        self.assertEqual(calls, ['synthetic-first', 'synthetic-second', 'synthetic-third'])

    def test_routed_scope_never_falls_back_to_local_files(self):
        module = self.load()
        (self.home / '.agentmemory/secret').write_text('other-profile-secret')
        module._routed_profile = lambda: True
        module._environment_value = lambda name: None
        self.assertEqual(module._configuration(), (module.DEFAULT_BASE_URL, ''))
        module._environment_value = lambda name: (_ for _ in ()).throw(RuntimeError('missing profile scope'))
        self.assertFalse(module.AgentMemoryProvider().is_available())
        self.assertEqual(module.AgentMemoryProvider().unavailable_reason(), 'missing profile scope')

    def test_replacement_evolves_only_exact_owned_previous_content(self):
        provider = self.provider()
        next_id = [0]
        evolved = []
        def request(base, path, body, **kwargs):
            if path == 'evolve':
                evolved.append(body['memoryId'])
            self.assertIn(path, ['remember', 'evolve'])
            next_id[0] += 1
            return {'success': True, 'memory': {'id': f'mem_{next_id[0]}', 'content': body.get('content', body.get('newContent')), 'project': provider._project}}
        self.module._api = request
        provider.on_memory_write('add', 'memory', 'old unrelated fact')
        provider.on_memory_write('replace', 'memory', 'completely different replacement', {'previous_content': 'old unrelated fact'})
        self.assertEqual(evolved, ['mem_1'])
        provider.on_memory_write('replace', 'memory', 'other', {'previous_content': 'old'})
        provider.on_memory_write('replace', 'user', 'other', {'previous_content': 'completely different replacement'})
        self.assertEqual(evolved, ['mem_1'])
        self.assertNotIn('old unrelated fact', (provider._hermes_home / 'agentmemory-mirrors.json').read_text())

    def test_mirror_ownership_survives_restart_and_failed_evolve_keeps_old_mapping(self):
        provider = self.provider()
        next_id = [0]
        evolved = []
        fail = [True]
        def request(base, path, body, **kwargs):
            if path == 'evolve':
                evolved.append(body['memoryId'])
                if fail[0]:
                    return {'success': False, 'errorCode': 'unavailable'}
            if path in ['remember', 'evolve']:
                next_id[0] += 1
                return {'success': True, 'memory': {'id': f'mem_{next_id[0]}', 'content': body.get('content', body.get('newContent')), 'project': provider._project}}
            return {'success': True}
        self.module._api = request
        provider.on_memory_write('add', 'memory', 'old')
        another = self.module.AgentMemoryProvider()
        another.initialize('restarted', cwd=str(self.home))
        another.on_memory_write('replace', 'memory', 'new', {'previous_content': 'old'})
        fail[0] = False
        another.on_memory_write('replace', 'memory', 'new', {'previous_content': 'old'})
        self.assertEqual(evolved, ['mem_1', 'mem_1'])
        records = json.loads((provider._hermes_home / 'agentmemory-mirrors.json').read_text())
        self.assertNotIn(provider._mirror_key('memory', 'old'), records)

    def test_external_evolution_conflict_never_deletes_or_creates_a_competing_record(self):
        provider = self.provider()
        self.module._api = lambda *a, **k: {'success': True, 'memory': {'id': 'mem_old', 'content': 'old', 'project': provider._project}}
        provider.on_memory_write('add', 'memory', 'old')
        calls = []
        self.module._api = lambda base, path, body, **k: calls.append((path, body)) or {'success': False, 'code': 'not_latest'}
        provider.on_memory_write('replace', 'memory', 'new', {'previous_content': 'old'})
        self.assertEqual(calls, [('evolve', {'memoryId': 'mem_old', 'newContent': 'new'})])
        self.assertEqual(json.loads((provider._hermes_home / 'agentmemory-mirrors.json').read_text())[provider._mirror_key('memory', 'old')], 'mem_old')

    def test_same_returned_id_is_never_deleted(self):
        provider = self.provider()
        deleted = []
        def request(base, path, body, **kwargs):
            if path in ('remember', 'evolve'):
                return {'success': True, 'memory': {'id': 'mem_same', 'content': body.get('content', body.get('newContent')), 'project': provider._project}}
            deleted.append(path)
            return {'success': True}
        self.module._api = request
        provider.on_memory_write('add', 'memory', 'old')
        provider.on_memory_write('replace', 'memory', 'new', {'previous_content': 'old'})
        self.assertEqual(deleted, [])

    def test_redirects_refuse_to_forward_credentials(self):
        module = self.load()
        request = module.Request('http://localhost:3111', headers={'Authorization': 'Bearer synthetic'})
        with self.assertRaises(HTTPError):
            module._NoRedirect().redirect_request(request, None, 302, 'redirect', {}, 'https://remote.invalid')

    def test_native_save_preserves_metadata_and_search_preserves_result_identity(self):
        provider = self.provider()
        result = json.loads(provider.handle_tool_call('memory_save', {'content': 'remember this', 'concepts': 'one, two,one', 'files': ['a.py', 'b.py'], 'agentId': 'agent-a'}))
        self.assertTrue(result['success'])
        payload = self.calls[-1][2]
        self.assertEqual(payload['concepts'], ['one', 'two'])
        self.assertEqual(payload['files'], ['a.py', 'b.py'])
        self.assertEqual(payload['agentId'], 'agent-a')
        self.assertEqual(payload['project'], self.home.name)
        expected = {'results': [{'observation': {'id': 'mem_one', 'concepts': ['one'], 'files': ['a.py']}, 'score': 0.8}]}
        self.module._api = lambda *a, **k: expected
        self.assertEqual(json.loads(provider.handle_tool_call('memory_recall', {'query': 'remember'})), expected)

    def test_prefetch_expands_scoped_compact_hits_and_keeps_beyond_title_evidence(self):
        provider = self.provider()
        calls = []
        def request(base, path, body, **kwargs):
            calls.append(body)
            if 'query' in body:
                return {'results': [{'obsId': 'mem_long', 'sessionId': 'memory', 'title': 'truncated title'}]}
            return {'results': [{'observation': {'id': 'mem_long', 'title': 'truncated title', 'narrative': 'prefix ' * 40 + 'BEYOND_TITLE_EVIDENCE'}}]}
        self.module._api = request
        context = provider.prefetch('query')
        self.assertIn('BEYOND_TITLE_EVIDENCE', context)
        self.assertEqual(calls[1], {'expandIds': [{'obsId': 'mem_long', 'sessionId': 'memory'}], 'project': provider._project})
        self.module._api = lambda *a, **k: {'results': None}
        self.assertEqual(provider.prefetch('query'), '')
        self.module._api = lambda *a, **k: {'results': [{'obsId': 7}, None, {'title': 'unknown'}]}
        self.assertEqual(provider.prefetch('query'), '')
        self.module._api = lambda base, path, body, **k: {'results': [{'obsId': 'mem_missing'}]} if 'query' in body else {'success': False, 'errorCode': 'authentication'}
        self.assertEqual(provider.prefetch('query'), '')

    def test_prefetch_cache_is_scoped_one_shot_and_invalidated_by_writes(self):
        provider = self.provider()
        calls = []
        self.module._api = lambda *a, **k: calls.append(a) or {'results': [{'observation': {'title': 'known', 'narrative': 'details'}}]}
        provider.queue_prefetch('query')
        self.assertEqual(len(calls), 1)
        self.assertIn('details', provider.prefetch('query'))
        self.assertEqual(len(calls), 1)
        provider.prefetch('query')
        self.assertEqual(len(calls), 2)
        provider.queue_prefetch('query')
        provider.sync_turn('user', 'answer')
        count = len(calls)
        provider.prefetch('query')
        self.assertEqual(len(calls), count + 1)

    def test_invalid_tool_arguments_never_reach_network(self):
        provider = self.provider()
        before = len(self.calls)
        for name, args in [('memory_save', {}), ('memory_save', {'content': 'x', 'files': [2]}), ('memory_save', {'content': 'x', 'project': ''}), ('memory_recall', {'query': 'x', 'limit': True}), ('memory_recall', {'query': 'x', 'limit': 0}), ('memory_search', {'query': 'x', 'targetLayer': 'private'}), ('memory_save', [])]:
            self.assertFalse(json.loads(provider.handle_tool_call(name, args))['success'], (name, args))
        self.assertEqual(len(self.calls), before)

    def test_search_failure_does_not_become_empty_success(self):
        provider = self.provider()
        self.module._api = lambda *a, **k: {'success': False, 'errorCode': 'authentication', 'error': 'Check AGENTMEMORY_SECRET.'}
        for name in ['memory_recall', 'memory_search', 'memory_save']:
            result = json.loads(provider.handle_tool_call(name, {'query': 'query', 'content': 'content'}))
            self.assertEqual(result['errorCode'], 'authentication')
            self.assertNotIn('results', result)

    def test_switch_orders_end_start_turn_and_end_uses_new_session(self):
        provider = self.provider()
        provider.sync_turn('first', 'response')
        provider.on_session_switch('new-session', reset=True)
        provider.sync_turn('second', 'response', session_id='')
        provider.on_session_end([])
        provider.on_session_end([])
        self.assertEqual([(path, body['sessionId']) for _, path, body, _ in self.calls], [('session/start', 'old-session'), ('observe', 'old-session'), ('session/end', 'old-session'), ('session/start', 'new-session'), ('observe', 'new-session'), ('session/end', 'new-session')])

    def test_failed_end_remains_retryable_and_same_session_rewind_does_not_restart(self):
        provider = self.provider()
        provider.on_session_switch('old-session', rewound=True)
        self.assertEqual(len(self.calls), 1)
        original = self.module._api
        self.module._api = lambda *a, **k: {'success': False}
        provider.on_session_end([])
        self.assertNotIn('old-session', provider._ended)
        self.module._api = original
        provider.on_session_end([])
        self.assertIn('old-session', provider._ended)

    def test_precompress_returns_bounded_context_without_mutating_transcript(self):
        provider = self.provider()
        self.module._api = lambda *a, **k: {'context': 'c' * 10000}
        messages = [{'role': 'user', 'content': 'original'}]
        self.assertEqual(provider.on_pre_compress(messages), 'c' * 8000)
        self.assertEqual(messages, [{'role': 'user', 'content': 'original'}])
        self.module._api = lambda *a, **k: {'success': False}
        self.assertEqual(provider.on_pre_compress(messages), '')

    def test_native_replace_is_mirrored_and_remove_never_guesses_shared_record_ids(self):
        provider = self.provider()
        provider.on_memory_write('add', 'memory', 'old')
        provider.on_memory_write('replace', 'memory', 'new', {'previous_content': 'old'})
        provider.on_memory_write('remove', 'memory', 'new')
        self.assertEqual([body['content'] for _, path, body, _ in self.calls if path == 'remember'], ['old', 'new'])

    def test_sync_waits_for_wire_completion_and_shutdown_waits_for_inflight_write(self):
        provider = self.provider()
        entered, release, completed = threading.Event(), threading.Event(), threading.Event()
        def request(*args, **kwargs):
            entered.set()
            release.wait(2)
            completed.set()
            return {'success': True}
        self.module._api = request
        writer = threading.Thread(target=provider.sync_turn, args=('user', 'assistant'))
        writer.start()
        self.assertTrue(entered.wait(1))
        shutdown = threading.Thread(target=provider.shutdown)
        shutdown.start()
        time.sleep(0.02)
        self.assertTrue(shutdown.is_alive())
        release.set()
        writer.join(1)
        shutdown.join(1)
        self.assertTrue(completed.is_set())
        self.assertFalse(shutdown.is_alive())

    def test_shutdown_is_bounded_and_late_writes_are_rejected(self):
        provider = self.provider()
        self.module.TIMEOUT = 0.02
        entered, release = threading.Event(), threading.Event()
        def hold():
            with provider._write_lock:
                entered.set()
                release.wait(1)
        holder = threading.Thread(target=hold)
        holder.start()
        self.assertTrue(entered.wait(1))
        start = time.monotonic()
        provider.shutdown()
        self.assertLess(time.monotonic() - start, 0.3)
        release.set()
        holder.join(1)
        before = len(self.calls)
        provider.sync_turn('late', 'write')
        self.assertEqual(len(self.calls), before)


if __name__ == '__main__':
    unittest.main()
