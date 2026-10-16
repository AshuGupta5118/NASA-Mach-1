"""Cross-check: does the browser harmoniser reproduce the Python pipeline exactly?

Run:  python3 tools/compare_implementations.py
Dumps the Python series to /tmp and then invokes the Node-side comparison.
"""
import sys, os, json, gzip, datetime, subprocess
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from pipeline.harmonize_core import Calibration, harmonise_series, bridge_factor

z = np.load(os.path.join(ROOT, 'data', 'sim_truth.npz'), allow_pickle=True)
cal = Calibration.from_dict(
    json.load(open(os.path.join(ROOT, 'data', 'calibration.json')))['calibration'])
gm, gv, gt = z['glob_m'], z['glob_v'], z['glob_t']
y0, ndays = int(z['y0']), int(z['ndays'])
d0 = datetime.date(y0, 1, 1)
days = [d0 + datetime.timedelta(days=i) for i in range(ndays)]
beta = bridge_factor(gm, gv, days, cal)
H = harmonise_series(gm, gv, days, cal, beta)
h = H['n_harm']
out = os.path.join(ROOT, 'data', '_py_series.json')
json.dump({
    'beta': beta,
    'n_harm': [round(float(x), 4) for x in h],
    'n_modis': [None if not np.isfinite(x) else round(float(x), 4) for x in H['n_modis']],
    'n_viirs': [None if not np.isfinite(x) else round(float(x), 4) for x in H['n_viirs']],
    'quality': [int(x) for x in H['quality']],
    'ratio_baseline': [None if not np.isfinite(x) else round(float(x), 6) for x in H['ratio_baseline']],
}, open(out, 'w'))
print('python: total %.1f  beta %.6f  quality counts %s'
      % (h.sum(), beta, np.bincount(H['quality']).tolist()))
print('python first 8:', [round(float(x), 3) for x in h[:8]])
print('wrote', out)

r = subprocess.run([sys.executable, '-c', 'pass'], capture_output=True)
node = subprocess.run(['node', os.path.join(ROOT, 'tools', '_cmp.js')],
                      capture_output=True, text=True, cwd=ROOT)
print(node.stdout)
if node.returncode:
    print(node.stderr[-2000:])
os.remove(out)
