"""Export selectable operator and summon outfits from a local Windows Arknights installation.

Writes a standalone tree containing data/local-skins.json and public/assets/local/skins/.
Run into an empty staging directory; the official client and stock assets.json are never changed.
Only named outfits of operators in this installation's assets.json are included. Input mappings
are from the CN skin table, not inferred from filenames. The client's active bundle list selects
base vs hot-update files. Missing files preserve the corresponding default appearance.
"""
from collections import defaultdict
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

from bundles import client_bundles

UNIT = re.compile(r'(?:char|token)_[0-9]+_[a-z0-9_]+\Z')
SKIN = re.compile(r'char_[0-9]+_[a-z0-9]+@[a-z0-9_-]+#[0-9]+\Z', re.I)
PART = re.compile(r'[a-zA-Z0-9_#-]+\Z')
SAFE_PAGE = re.compile(r'[a-zA-Z0-9._-]+\.png\Z')
ROOT = Path(__file__).resolve().parents[2]
URL = '/assets/local/'


def plan(table, assets, selected):
    chars, tokens = defaultdict(list), defaultdict(list)
    for sid, skin in sorted(table['charSkins'].items()):
        cid = skin.get('charId')
        if not isinstance(cid, str) or not UNIT.fullmatch(cid) or not SKIN.fullmatch(sid) or not sid.startswith(cid + '@'):
            continue
        if cid not in assets['chars'] or (selected and cid not in selected):
            continue
        display = skin.get('displaySkin') or {}
        name = display.get('skinName')
        if not isinstance(name, str) or not name.strip():
            continue
        rec = {'name': name, 'group': display.get('skinGroupName') or ''}
        chars[cid].append((sid, skin, rec))
        for mapping in skin.get('tokenSkinMap') or []:
            token, prefab = mapping.get('tokenId'), mapping.get('tokenSkinId')
            if isinstance(token, str) and UNIT.fullmatch(token) and token in assets['tokens'] and valid_part(prefab):
                tokens[token].append((sid, prefab, {'name': name, 'group': rec['group']}))
    return chars, tokens


def valid_part(s):
    return isinstance(s, str) and bool(PART.fullmatch(s))


def location(unit, sid):
    suffix = sid.split('@', 1)[1]
    digest = hashlib.sha256(sid.encode()).hexdigest()[:10]
    return f'skins/{unit}/{suffix.lower().replace("#", "-")}-{digest}'


def save_picture(img, out, sub, slot, trim=False):
    img = img.convert('RGBA')
    if trim:
        bbox = img.getbbox(alpha_only=True)
        if not bbox:
            return None
        img = img.crop(bbox)
        img.thumbnail((1600, 1600))
    file = f'{sub}/{slot}.png'
    target = out / file
    target.parent.mkdir(parents=True, exist_ok=True)
    img.save(target)
    return URL + file


def pictures(root, chars, out, log, UnityPy):
    for slot, glob in [('avatar', 'ui_char_avatar_*.ab'), ('portrait', 'char_portrait_*.ab')]:
        wanted = defaultdict(list)
        for cid, jobs in chars.items():
            for sid, src, rec in jobs:
                key = src.get(slot + 'Id')
                if valid_part(key):
                    wanted[key.lower()].append((location(cid, sid), rec))
        for bundle in sorted((root / 'spritepack').glob(glob)):
            if not wanted:
                break
            try:
                env = UnityPy.load(str(bundle))
                for name, obj in env.container.items():
                    key = name.rsplit('/', 1)[-1].removesuffix('.png').lower()
                    if key not in wanted or obj.type.name != 'Sprite':
                        continue
                    try:
                        image = obj.read().image
                        for sub, rec in wanted[key]:
                            rec[slot] = save_picture(image, out, sub, slot)
                        del wanted[key]
                    except Exception as err:
                        log(f'warn {bundle.name} {key}: {err}')
            except Exception as err:
                log(f'warn {bundle.name}: {err}')
        if wanted:
            log(f'{slot}: {len(wanted)} source sprites not found')


def normalize_pages(out, sub, group, atlas, atlas_pages):
    # Unity atlas page names can contain # (a URL fragment). Update both the file and its atlas page header.
    text = (out / sub / atlas).read_text(encoding='utf-8')
    pages = atlas_pages(text)
    for i, page in enumerate(pages):
        if SAFE_PAGE.fullmatch(page):
            continue
        new = f'page-{i}-{hashlib.sha256(page.encode()).hexdigest()[:8]}.png'
        (out / sub / page).rename(out / sub / new)
        group[new] = {**group.pop(page), 'path': f'{URL}{sub}/{new}'}
        text = re.sub(r'^' + re.escape(page) + r'$', new, text, count=1, flags=re.M)
        pages[i] = new
    (out / sub / atlas).write_text(text, encoding='utf-8', newline='\n')
    return [group[page]['path'] for page in pages]


def extract_models(root, units, out, kind, log, UnityPy, pending):
    from extract import atlas_pages, pick_spine_node, prefab_spine_nodes, write_spine

    for unit, jobs in units.items():
        bundle = root / 'skinpack' / (unit + '.ab')
        if not bundle.is_file():
            log(f'skip missing {bundle.name}')
            continue
        try:
            env = UnityPy.load(str(bundle))
            container = {k.lower(): v for k, v in env.container.items()}
            # Path ids are scoped to the prefab's serialized file.
            sprites = {o.peek_name().lower(): o for o in env.objects if o.type.name == 'Sprite'} if kind == 'chars' else {}
        except Exception as err:
            log(f'warn {bundle.name}: {err}')
            continue
        for sid, src, rec in jobs:
            sub = location(unit, sid)
            prefab = src if kind == 'tokens' else (src.get('battleSkin') or {}).get('skinOrPrefabId')
            if valid_part(prefab):
                obj = container.get(f'dyn/battle/prefabs/skins/character/{unit}/{prefab.lower()}.prefab')
                if obj is not None:
                    try:
                        prefab_obj = obj.deref()
                        objects = prefab_obj.assets_file.objects
                        nodes = prefab_spine_nodes(prefab_obj.read_typetree(), objects)
                        front = next((n for n in nodes if n[0].lower() == 'front'), None)
                        if front is None and (kind == 'tokens' or any(n[0].lower() == 'spine' for n in nodes)):
                            front = pick_spine_node(nodes)
                        back = next((n for n in nodes if n[0].lower() == 'back'), None)
                        for face, node in [('front', front), ('back', back)]:
                            if not node or (face == 'back' and front is None):
                                continue
                            ref = node[2]
                            sda = objects.get(ref['m_PathID']) if not ref.get('m_FileID') else None
                            if sda is None:
                                continue
                            folder, group = f'{sub}/{face}', {}
                            # Prevalidate page paths before write_spine uses an atlas page as a filename.
                            tree = sda.read_typetree()
                            for ar in tree.get('atlasAssets') or []:
                                aa = objects.get(ar['m_PathID']) if not ar.get('m_FileID') else None
                                af = aa.read_typetree().get('atlasFile') if aa else None
                                a = objects.get(af['m_PathID']) if af and not af.get('m_FileID') else None
                                if a:
                                    from extract import _text_bytes
                                    if any(not re.fullmatch(r'[a-zA-Z0-9_# .\[\]-]+\.png', n) or n.startswith('.')
                                           for n in atlas_pages(_text_bytes(a.read()).decode('utf-8', 'replace'))):
                                        raise ValueError('unexpected atlas page file name')
                            write_spine(objects, tree, folder, unit, out, group, log)
                            if folder not in group:
                                continue
                            files = group[folder]
                            skel = next(k for k in files if k.endswith('.skel'))
                            atlas = skel[:-5] + '.atlas'
                            pages = normalize_pages(out, folder, files, atlas, atlas_pages)
                            entry = {'skel': files[skel]['path'], 'atlas': files[atlas]['path'], 'textures': pages}
                            pending.append((rec, face, entry, str(out / folder / skel)))
                    except Exception as err:
                        log(f'warn {sid} {unit} model: {err}')
            if kind == 'chars':
                illust = src.get('illustId')
                if isinstance(illust, str) and illust.startswith('illust_'):
                    sprite = sprites.get(illust.lower().removeprefix('illust_'))
                    if sprite is not None:
                        try:
                            picture = save_picture(sprite.read().image, out, sub, 'illust', trim=True)
                            if picture:
                                rec['illust'] = picture
                        except Exception as err:
                            log(f'warn {sid} illustration: {err}')


def load_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def export(root, assets, table, output, node, selected=(), log=print):
    import aklz4  # noqa: F401
    import UnityPy

    chars, tokens = plan(table, assets, selected)
    if not chars:
        raise ValueError('no named roster outfits matched the source tables')
    out = output / 'public' / 'assets' / 'local'
    pending = []
    with client_bundles(root, log) as client:
        pictures(client, chars, out, log, UnityPy)
        extract_models(client, chars, out, 'chars', log, UnityPy, pending)
        extract_models(client, tokens, out, 'tokens', log, UnityPy, pending)
    proc = subprocess.run([node, str(Path(__file__).with_name('skin-models.mjs'))],
                          input=json.dumps([p[3] for p in pending]), capture_output=True, check=True,
                          text=True, encoding='utf-8', timeout=180)
    for (rec, face, model, skel), meta in zip(pending, json.loads(proc.stdout), strict=True):
        if 'error' in meta:
            log(f'warn {skel}: {meta["error"]}')
        else:
            rec.setdefault('spine', {})[face] = {**model, **meta}
    report = {}
    doc = {'version': 1}
    for kind, units in [('chars', chars), ('tokens', tokens)]:
        doc[kind] = {}
        missing = []
        partial = []
        for unit, jobs in units.items():
            skins = {}
            for sid, _, rec in jobs:
                if 'front' not in rec.get('spine', {}):
                    rec.pop('spine', None)
                if not any(k in rec for k in ('avatar', 'portrait', 'illust', 'spine')):
                    missing.append({'unit': unit, 'skinId': sid})
                    continue
                missing_parts = [key for key in ('front', 'back', 'avatar', 'portrait', 'illust')
                                 if key not in rec.get('spine', {}) and key not in rec] if kind == 'chars' else []
                if missing_parts:
                    partial.append({'unit': unit, 'skinId': sid, 'missing': missing_parts})
                skins[sid] = rec
            if skins:
                doc[kind][unit] = {'skins': skins}
        records = [rec for value in doc[kind].values() for rec in value['skins'].values()]
        report[kind] = {'units': len(doc[kind]), 'outfits': len(records), 'front': sum('front' in r.get('spine', {}) for r in records),
                        'back': sum('back' in r.get('spine', {}) for r in records), 'avatar': sum('avatar' in r for r in records),
                        'portrait': sum('portrait' in r for r in records), 'illust': sum('illust' in r for r in records),
                        'missing': missing, 'partial': partial}
    if not doc['chars']:
        raise ValueError('no wearable outfits extracted; refusing to write an empty sidecar')
    (output / 'data').mkdir(parents=True, exist_ok=True)
    (output / 'data' / 'local-skins.json').write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    (output / 'coverage.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    for kind, stats in report.items():
        log(f'{kind}: ' + str({k: len(v) if isinstance(v, list) else v for k, v in stats.items()}))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--client', required=True, type=Path, help='Windows game directory containing Arknights_Data')
    ap.add_argument('--skin-table', required=True, type=Path, help='CN skin_table.json including tokenSkinMap')
    ap.add_argument('--assets', type=Path, default=ROOT / 'data' / 'assets.json', help='original v0.4.0 roster manifest')
    ap.add_argument('--output', required=True, type=Path, help='new, empty staging directory')
    ap.add_argument('--node', default='node', help='path to Node.js executable (>=22)')
    ap.add_argument('--operator', action='append', default=[], help='restrict staging to one or more operator ids')
    args = ap.parse_args()
    if args.output.exists() and (not args.output.is_dir() or any(args.output.iterdir())):
        ap.error('--output must be a new or empty staging directory')
    root = args.client / 'Arknights_Data' / 'StreamingAssets' / 'AB' / 'Windows'
    if not (root / 'skinpack').is_dir():
        ap.error(f'no Windows skinpack under {root}')
    export(root, load_json(args.assets), load_json(args.skin_table), args.output.resolve(), args.node,
           args.operator, lambda line: print(line, flush=True))


if __name__ == '__main__':
    main()
