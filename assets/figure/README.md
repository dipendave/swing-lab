# The player model

Everything in this folder is built by `tools/build_figure.py` from the MakeHuman
project's assets, which MakeHuman released under CC0 1.0 (public domain):

- the base mesh, its default skeleton and weights, and the body-shape targets,
  from https://github.com/makehumancommunity/makehuman (`makehuman/data`)
- the clothes (`male_casualsuit01`, `shoes05`), skins, eyes, eyebrows,
  eyelashes and hair (`short02`), from the "MakeHuman system assets" pack at
  http://files.makehumancommunity.org/asset_packs/makehuman_system_assets/

To rebuild, with numpy and Pillow installed:

```
python3 -I tools/build_figure.py <makehuman/makehuman/data> <unzipped asset pack> assets/figure
```

`figure.json` says what is in `figure.bin` (seven meshes, each bound to the
sixteen bones in `src/pose.js`) and where the model's joints are. The script
prints the bone lengths it measured; `src/pose.js` must use the same ones, and
`tests/figure.test.js` fails if they drift apart.
