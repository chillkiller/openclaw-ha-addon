import pathlib, re
f = pathlib.Path('openclaw_ha_addon/config.yaml')
c = f.read_text(encoding='utf-8')
c = re.sub(r'^version:\s*\"0\.7\.10\.10\"', 'version: \"0.7.10.11\"', c, flags=re.M)
f.write_text(c, encoding='utf-8')
print('bumped')
