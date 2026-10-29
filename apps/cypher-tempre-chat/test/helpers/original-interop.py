"""Independent reference fixture; imports only an explicitly supplied original skill.

This helper uses disposable, marked roots. It never mutates the supplied source
tree, and only installs a known benign authored operator in its explicit fixture
mode. Test scores/data are synthetic transport fixtures, not quality benchmarks.
"""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import shutil
import sys

source = Path(sys.argv[1]).resolve()
request = json.load(sys.stdin)
root = Path(request['root']).resolve()
if root == source or source in root.parents:
    raise ValueError('The original source tree is never a fixture destination.')
if request['mode'] != 'initialize' and not (root / '.interop-fixture').is_file():
    raise ValueError('Only marked interoperability fixtures may be touched.')

# Explicit reference execution is isolated from the bridge interpreter. Normal
# inspect/verify do not load fixture Python; only authored_reference opts in.
sys.path.insert(0, str(source))
if request['mode'] == 'authored_reference':
    sys.path.insert(0, str(root))
from timechain import Timechain
import cambium
import faculties
import modality_ops

FRUITS = ['love', 'peace', 'joy', 'kindness', 'mildness', 'self-control', 'goodness', 'patience', 'faith']
SCORES = {key: 240 for key in ['coherence', 'relevance', 'novelty', 'consistency', 'depth', 'covenant']}
MEMORY = 'The original lab notebook records specimen Opal Lantern 318; its calibration uncertainty is 0.25 units.'
FRAME = 'Separate a recorded observation from an inference; cite the source label and state calibration uncertainty.'
SPECS = [
    ('modality', 'Metamaterial Resonance Reasoning', 'Reason about metamaterial split-ring resonator permittivity and measured linewidth with calibrated uncertainty.', 'metamaterial permittivity splitring resonator linewidth frequency calibration'),
    ('modality', 'Archive Provenance Reasoning', 'Trace archive provenance and notebook lineage without inferring measurements absent from the source.', 'archive provenance notebook lineage corroboration attestation'),
    ('sense', 'Cryogenic Gradient Sensing', 'Detect cryogenic thermometry gradients and thermalization uncertainty in supplied measurements.', 'cryogenic thermometry cryostat bolometer thermalization kelvin gradient'),
]

def snapshot():
    tc = Timechain(root)
    verified, details = tc.verify()
    records = [r for r in tc.iter_rings()]
    paths = ('registry/modalities.json', 'registry/senses.json', 'registry/grown.json',
             'registry/grown_ops.json', 'registry/emergent.json', 'registry/policy.json',
             'registry/scorer.json', 'registry/labeler.json', 'registry/lens/ACTIVE')
    files = {name: {'sha256': hashlib.sha256((root / name).read_bytes()).hexdigest(),
                    'text': (root / name).read_text(encoding='utf-8')} for name in paths if (root / name).is_file()}
    return {'verified': verified, 'details': details, 'head': {'index': records[-1]['index'], 'hash': records[-1]['ring_hash']},
            'rings': [{'index': r['index'], 'hash': r['ring_hash'], 'type': r['ring_type'], 'payload': r.get('payload')} for r in records],
            'grown': cambium.load_grown(root), 'emergent': cambium.load_emergent(root),
            'ops': json.loads((root / 'registry/grown_ops.json').read_text(encoding='utf-8')) if (root / 'registry/grown_ops.json').is_file() else {},
            'files': files}

with contextlib.redirect_stdout(io.StringIO()):
    mode = request['mode']
    if mode == 'initialize':
        if root.exists() and any(root.iterdir()):
            raise ValueError('Initialize requires a fresh empty fixture root.')
        (root / 'registry').mkdir(parents=True, exist_ok=True)
        (root / '.interop-fixture').write_text('disposable independent interoperability test', encoding='utf-8')
        for name in ('modalities.json', 'senses.json'):
            shutil.copyfile(source / 'registry' / name, root / 'registry' / name)
        Timechain(root).genesis('Original Interoperability Fixture')
        if request.get('faculties', True):
            for kind, name, purpose, query in SPECS:
                cambium.grow(root, query, mode='sprout', kind_override=kind, registry_root=root,
                             force=True, name_override=name, function_override=purpose)
            cambium.set_effect(root, SPECS[1][1], 'frame', FRAME, registry_root=root)
            grown = cambium.load_grown(root)
            grown['senses'][0]['status'] = 'dormant'
            grown['senses'][0]['dormancy_reason'] = 'Explicit isolated test hibernation'
            cambium.save_grown(root, grown)
            faculties.author_pack(root, {'name': 'Independent Emergent Fixture', 'version': '1.0.0', 'faculties': [
                {'kind': 'sense', 'name': 'Ocean Vorticity Sensing', 'function': 'Distinguish vorticity and eddies from insufficient current measurements.',
                 'category': 'structural', 'seed_terms': ['vorticity', 'eddy', 'baroclinic']}]})
            cambium.propose_op(root, 'Inert Test Operator', 'return {"inert": True}', kind='sense',
                               function='An inert proposal requiring explicit local review.', registry_root=root)
        import recall
        ring, labels, verdict = recall.Recall(root, registry_root=root).seal('experience', MEMORY, external_scores=SCORES)
        import extractor
        extractor.teach(root, 'Record the notebook provenance and uncertainty.', modalities=[2], senses=[5], registry_root=root)
        result = snapshot()
        result.update(memory=MEMORY, frame=FRAME, version=(source / 'VERSION').read_text(encoding='utf-8').strip())
    elif mode in ('inspect', 'verify'):
        result = snapshot()
    elif mode == 'grow':
        name = request.get('name', 'Interferometric Visibility Reasoning')
        grown, ring = cambium.grow(root, 'interferometric visibility coherence baseline fringe angular calibration', mode='sprout',
                    kind_override='modality', registry_root=root, force=True, name_override=name,
                    function_override='Reason about interferometric fringe visibility from supplied observations with explicit uncertainty.')
        result = {'growth': grown, 'ring': ring, 'snapshot': snapshot()}
    elif mode == 'train_labeler':
        import extractor
        grown = cambium.load_grown(root)
        targets = grown['modalities'][:2]
        for i in range(64):
            faculty = targets[i % 2]
            extractor.teach(root, faculty['function'] + ' fixture measurement ' + str(i),
                            modalities=[faculty['id']], senses=[], registry_root=root)
        report = extractor.train_labeler(root, registry_root=root)
        adopted = extractor.adopt_labeler(root, report, registry_root=root)
        result = {'training': {'pairs': report['pairs'], 'eval': report['eval']},
                  'adoption': adopted, 'snapshot': snapshot()}
    elif mode == 'set_effect':
        result = {'faculty': cambium.set_effect(root, request['name'], request['effectType'], request['value'], registry_root=root),
                  'snapshot': snapshot()}
    elif mode == 'seal':
        import recall
        ring, labels, verdict = recall.Recall(root, registry_root=root).seal('experience', request['text'], external_scores=SCORES)
        result = {'ring': ring, 'labels': labels, 'verdict': verdict, 'verified': Timechain(root).verify()[0]}
    elif mode == 'ops':
        result = modality_ops.run_all(request['names'], request['text'], request.get('context', ''), extra_ops=modality_ops.load_grown_ops(root))
    elif mode == 'legacy_export':
        result = faculties.export_pack(root, 'Independent Original Pack', version='1.0.0', include_emergent=request.get('includeEmergent', False))
    elif mode == 'legacy_import':
        result = {'report': faculties.import_pack(root, request['pack']), 'snapshot': snapshot()}
    elif mode == 'install_authored_fixture':
        name = 'Locally Approved Sentinel'
        code = 'return {"fixture": "approved-native-sentinel", "characters": len(text)}'
        cambium.propose_op(root, name, code, kind='sense', function='Return a benign test sentinel and text length.', registry_root=root)
        activated, ring = cambium.activate(root, name, registry_root=root)
        # This known test module intentionally records import as a marker. A
        # preview/pair must never create that marker before explicit approval.
        module = ('from pathlib import Path\n'
                  'Path(__file__).with_name("AUTHORED_IMPORT_SENTINEL").write_text("imported", encoding="utf-8")\n'
                  'def sentinel(text, context=""):\n'
                  '    return {"fixture": "approved-native-sentinel", "characters": len(text)}\n'
                  'OPS = {"Locally Approved Sentinel": sentinel}\n')
        (root / 'active_ops.py').write_text(module, encoding='utf-8')
        result = {'name': name, 'key': 'sense:' + str(activated['promoted_to_id']),
                  'sha256': hashlib.sha256((root / 'active_ops.py').read_bytes()).hexdigest(),
                  'sideEffect': str(root / 'AUTHORED_IMPORT_SENTINEL'), 'verified': Timechain(root).verify()[0]}
    elif mode == 'authored_reference':
        result = {'computed': modality_ops.run_all(['Locally Approved Sentinel'], request.get('text', 'sample')),
                  'modulePath': getattr(sys.modules.get('active_ops'), '__file__', None)}
    else:
        raise ValueError(mode)
print(json.dumps(result, ensure_ascii=False, default=lambda value: sorted(value) if isinstance(value, set) else str(value)))
