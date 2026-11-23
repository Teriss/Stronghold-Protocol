"""Run with `py -3.12 -B test/skin-fx-extract.py`; does not use a client or UnityPy."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools/local-extract'))
import fx
import extract
from bundles import client_bundles


CID = 'char_1033_swire2'
PREFAB = f'{CID}_ambiencesynesthesia#4'
SID = f'{CID}@ambienceSynesthesia#4'


class FakeAssetEnv:
    def __init__(self, *args):
        self.go = SimpleNamespace(assets_file=object())
        self.child = SimpleNamespace(assets_file=self.go.assets_file)
        self.component = SimpleNamespace(type=SimpleNamespace(name='MonoBehaviour'))

    def prefabs(self, rel, full=False):
        return {
            f'{fx.SKIN_ROOT}/{CID}/{PREFAB}.prefab': self.go,
            f'dyn/arts/characters/{CID}/{PREFAB}.prefab': self.go,
        }

    def resolve(self, sfile, ref):
        return sfile, ref

    def script(self, obj):
        # Unavailable MonoScript is permitted only with the complete hooker field signature.
        return '', '?'

    def tt(self, obj):
        if obj is self.go:
            return {'m_Name': PREFAB, 'm_Component': []}
        if obj is self.child:
            return {'m_Component': [{'component': self.component}]}
        return {'_replaceEffectPairs': [{'fromEffect': 'Default', 'toEffect': 'EXACT'},
                                        {'fromEffect': None, 'toEffect': 'invalid'}],
                '_useFakeProjectile': True,
                '_fakeProjectileConfigs': [{'originProjectileKey': 'PROJECTILE', '_fakeMuzzlePoint': 8}]}


class SkinFxExtract(unittest.TestCase):
    def test_packs_and_official_spelling(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            table = root / 'official.json'
            table.write_text(json.dumps({'charSkins': {SID: {}}}), encoding='utf-8')
            official = fx.official_skin_ids(root, table)
            self.assertEqual(SID, fx.skin_id(CID, PREFAB, CID + '_ambienceSynesthesia#4', {}))
            self.assertEqual(SID, official[SID.casefold()])
            with patch.object(fx, 'AssetEnv', FakeAssetEnv), patch.object(
                    fx, 'go_children', lambda env, go: [env.child] if go is env.go else []), patch.object(
                    fx, 'skin_points', return_value={'HitPoint': {'all': {'pos': [1, 2, 3]}}}):
                unit = {'graphic': {'pos': [0, 0, 0]}}
                self.assertEqual({}, fx.skin_hooks(root, {}, {CID: unit}, official, lambda s: None))
                bundle = root / f'skinpack/{CID}.ab'
                bundle.parent.mkdir()
                bundle.touch()
                skins = fx.skin_hooks(root, {}, {CID: unit, 'char_missing': {}}, official, lambda s: None)
            self.assertEqual({SID}, skins.keys())
            self.assertEqual({'default': 'exact'}, skins[SID]['replace'])
            self.assertEqual(unit['graphic'], skins[SID]['graphic'])
            self.assertEqual([{'originProjectileKey': 'PROJECTILE', 'fakeMuzzlePoint': 8}], skins[SID]['fakeProjectiles'])
            self.assertEqual({'default', 'exact'}, fx.skin_referenced(skins, {'exact': 'pack'}))
            self.assertIn('projectile', fx.skin_referenced(skins, {'projectile': 'pack'}))

    def test_active_hot_update_not_stale_base(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / 'Arknights_Data/StreamingAssets/AB/Windows'
            hot = base.parents[2] / 'PersistentData/Bundles'
            rel = f'skinpack/{CID}.ab'
            missing = 'skinpack/char_missing.ab'
            for folder, text in ((base, 'old'), (hot, 'new')):
                (folder / rel).parent.mkdir(parents=True)
                (folder / rel).write_text(text, encoding='utf-8')
            (base / missing).write_text('stale', encoding='utf-8')

            def index(folder, name, version, records):
                (folder / name).write_text(json.dumps({
                    'versionId': version, 'manifestName': version + '.idx', 'manifestVersion': 'V079',
                    'abInfos': [{'name': p, 'hash': h} for p, h in records.items()],
                }), encoding='utf-8')

            index(base, 'hot_update_list.json', '26-10-20-11-10-38-10000000', {rel: 'old', missing: 'old'})
            index(hot, 'hot_update_list.json', '26-11-13-06-34-18-10000000', {rel: 'new', missing: 'not-downloaded'})
            index(hot, 'persistent_res_list.json', '26-11-13-06-34-18-10000000', {rel: 'new'})
            with client_bundles(base, lambda s: None) as active:
                self.assertEqual('new', (active / rel).read_text(encoding='utf-8'))
                self.assertFalse((active / missing).exists())
            self.assertEqual('old', (base / rel).read_text(encoding='utf-8'))

    def test_opt_in_export_and_absent_skinpack(self):
        changes = {SID: {'replace': {'base': 'variant'}}}
        bundle_count = {}

        def export_worker(work, _keys):
            exported = work[4]
            bundle_count['keys'] = set(exported)
            return {k: {'file': f'prefabs/{k}.json'} for k in exported}, {}, {}, []

        with tempfile.TemporaryDirectory() as tmp, patch.multiple(
                fx, FX_SAMPLE_KEYS=[], FX_COVERAGE_KEYS=[], FX_GENERIC={}, FX_SAMPLE_UNITS=[CID]), patch.object(
                fx, 'scan_cabs', return_value={}), patch.object(
                fx, 'container_index', return_value={'base': 'test.ab', 'variant': 'test.ab'}), patch.object(
                fx, 'game_data', return_value={}), patch.object(
                fx, 'crawl_units', return_value=({CID: {}}, {}, {}, {}, set())), patch.object(
                fx, '_export_worker', side_effect=export_worker), patch.object(fx, 'skin_hooks') as hooks:
            for name, enabled, extracted in [('default', False, {}), ('no-pack', True, {}), ('skins', True, changes)]:
                with self.subTest(name=name):
                    root = Path(tmp) / name
                    hooks.return_value = extracted
                    bundle_count.clear()
                    manifest = root / 'data/local-fx.json'
                    fx.export_fx(root, root / 'local', {}, lambda s: None, jobs=1, root=root,
                                 fx_manifest=manifest, include_skins=enabled, texture_format='png')
                    doc = json.loads((root / 'local/fx/index.json').read_text(encoding='utf-8'))
                    self.assertEqual(3, doc['version'])
                    self.assertEqual({}, doc['skins'])
                    groups = json.loads(manifest.read_text(encoding='utf-8'))['groups']
                    if extracted:
                        self.assertEqual(changes, doc['skinFx'])
                        self.assertEqual({'base', 'variant'}, groups['fx/prefabs'].keys())
                        self.assertEqual({'base', 'variant'}, bundle_count['keys'])
                    else:
                        self.assertNotIn('skinFx', doc)
                        self.assertFalse(bundle_count)
                    self.assertEqual(enabled, hooks.called)
                    hooks.reset_mock()
                    if extracted:
                        for options in ({'keys': ['base']}, {'add_only': True}):
                            fx.export_fx(root, root / 'local', {}, lambda s: None, jobs=1, root=root,
                                         fx_manifest=manifest, texture_format='png', **options)
                            partial = json.loads((root / 'local/fx/index.json').read_text(encoding='utf-8'))
                            self.assertEqual(changes, partial['skinFx'])
                        hooks.assert_not_called()

    def test_staging_cli_never_uses_project_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            with patch.object(extract, 'locate_client', return_value=root), patch.object(fx, 'export_fx', return_value=1) as export:
                stage = root / 'output'
                sys_argv = ['extract', '--only', 'fx', '--fx-skins', str(stage)]
                with patch.object(sys, 'argv', sys_argv):
                    self.assertEqual(0, extract.main())
                kwargs = export.call_args.kwargs
                self.assertEqual(stage / 'public/assets/local', export.call_args.args[1])
                self.assertEqual(stage / 'data/local-fx.json', kwargs['fx_manifest'])
                self.assertEqual(stage / '.cache/fx', kwargs['cache_dir'])
                self.assertTrue(kwargs['include_skins'])
            protected = subprocess.run([sys.executable, '-B', str(ROOT / 'tools/local-extract/extract.py'),
                                        '--only', 'fx', '--fx-skins', str(ROOT / 'public/assets/local')],
                                       capture_output=True, text=True, encoding='utf-8')
            self.assertEqual(2, protected.returncode)
            self.assertIn('staging must be outside the project', protected.stderr)


if __name__ == '__main__':
    unittest.main()
