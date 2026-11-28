#!/usr/bin/env python3
"""Build the player model the site uses from MakeHuman's CC0 assets.

    python3 -I tools/build_figure.py <makehuman/data> <asset pack> assets/figure

<makehuman/data>  makehuman/makehuman/data from github.com/makehumancommunity/makehuman
<asset pack>      the unzipped makehuman_system_assets_cc0 pack
                  (files.makehumancommunity.org/asset_packs/makehuman_system_assets/)

Writes figure.json (what is in the file, and where the joints are), figure.bin
(the meshes) and the textures. Needs numpy and Pillow.

The body is MakeHuman's base mesh shaped as a young man, wearing its shirt and
trousers (recoloured as cricket whites) and its trainers. Every vertex is tied
to the sixteen bones the pose solver in src/pose.js moves, by adding together
the weights MakeHuman gives its own, much finer skeleton.

Axes on the way out are the solver's: the figure faces +y, its left side is
toward -x, z is up, metres, soles on z = 0.
"""
import json
import os
import struct
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HEIGHT = 1.80  # metres, barefoot crown height before the shoes are put on
BONES = ['pelvis', 'waist', 'chest', 'head', 'armL', 'foreL', 'handL', 'armR', 'foreR', 'handR',
         'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR']
BI = {b: i for i, b in enumerate(BONES)}


# ------------------------------------------------------------------ reading
def read_obj(path):
    v, vt, faces, groups = [], [], [], []
    g = ''
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            if line.startswith('v '):
                p = line.split()
                v.append((float(p[1]), float(p[2]), float(p[3])))
            elif line.startswith('vt '):
                p = line.split()
                vt.append((float(p[1]), float(p[2])))
            elif line.startswith('g '):
                g = line.split()[1]
            elif line.startswith('f '):
                corners = []
                for c in line.split()[1:]:
                    q = c.split('/')
                    corners.append((int(q[0]) - 1, int(q[1]) - 1 if len(q) > 1 and q[1] else -1))
                faces.append(corners)
                groups.append(g)
    return np.array(v, dtype=np.float64), np.array(vt, dtype=np.float64), faces, groups


def read_target(path):
    idx, off = [], []
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            if line.startswith('#') or not line.strip():
                continue
            p = line.split()
            idx.append(int(p[0]))
            off.append((float(p[1]), float(p[2]), float(p[3])))
    return np.array(idx, dtype=np.int64), np.array(off, dtype=np.float64)


def read_mhclo(path):
    """A fitted item: each of its vertices rides on a triangle of the body."""
    out = {'refs': [], 'scale': {}, 'delete': set(), 'weights_file': None, 'obj': None}
    mode = None
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith('#'):
                continue
            p = s.split()
            head = p[0]
            if not head.lstrip('-').replace('.', '', 1).isdigit():
                # a keyword. Only these three start a new section; the rest can
                # turn up anywhere, even between "verts" and its numbers.
                if head in ('verts', 'delete_verts', 'weights'):
                    mode = head
                elif head in ('x_scale', 'y_scale', 'z_scale'):
                    out['scale'][head[0]] = (int(p[1]), int(p[2]), float(p[3]))
                elif head == 'obj_file':
                    out['obj'] = p[1]
                elif head == 'vertexboneweights_file':
                    out['weights_file'] = p[1]
                continue
            if mode == 'verts':
                if len(p) == 1:
                    out['refs'].append(((int(p[0]),) * 3, (1.0, 0.0, 0.0), (0.0, 0.0, 0.0)))
                else:
                    out['refs'].append(((int(p[0]), int(p[1]), int(p[2])),
                                        (float(p[3]), float(p[4]), float(p[5])),
                                        (float(p[6]), float(p[7]), float(p[8])) if len(p) > 8 else (0.0, 0.0, 0.0)))
            elif mode == 'delete_verts':
                i = 0
                while i < len(p):
                    if i + 2 < len(p) and p[i + 1] == '-':
                        out['delete'].update(range(int(p[i]), int(p[i + 2]) + 1))
                        i += 3
                    else:
                        out['delete'].add(int(p[i]))
                        i += 1
    return out


def fit(clo, body):
    """Where the item's vertices are on this body."""
    scale = np.ones(3)
    for n, ax in enumerate('xyz'):
        if ax in clo['scale']:
            a, b, den = clo['scale'][ax]
            scale[n] = abs(body[a, n] - body[b, n]) / den
    idx = np.array([r[0] for r in clo['refs']], dtype=np.int64)
    w = np.array([r[1] for r in clo['refs']])
    off = np.array([r[2] for r in clo['refs']])
    pos = (body[idx] * w[:, :, None]).sum(axis=1) + off * scale
    return pos, idx, w


# ---------------------------------------------------------------- the bones
def bone_share(name):
    """Which of our bones a MakeHuman bone moves with, as {bone: share}."""
    side = 'L' if name.endswith('.L') else 'R' if name.endswith('.R') else ''
    base = name[:-2] if side else name
    if base in ('root', 'spine05', 'pelvis'):
        return {'pelvis': 1}
    if base == 'spine04':
        return {'pelvis': 0.35, 'waist': 0.65}
    if base == 'spine03':
        return {'waist': 1}
    if base == 'spine02':
        return {'waist': 0.3, 'chest': 0.7}
    if base in ('spine01', 'clavicle', 'breast', 'neck01'):
        return {'chest': 1}
    if base == 'shoulder01':
        return {'chest': 0.6, 'arm' + side: 0.4}
    if base == 'neck02':
        return {'chest': 0.5, 'head': 0.5}
    if base in ('upperarm01', 'upperarm02'):
        return {'arm' + side: 1}
    if base in ('lowerarm01', 'lowerarm02'):
        return {'fore' + side: 1}
    if base == 'wrist' or base.startswith('metacarpal') or base.startswith('finger'):
        return {'hand' + side: 1}
    if base in ('upperleg01', 'upperleg02'):
        return {'thigh' + side: 1}
    if base in ('lowerleg01', 'lowerleg02'):
        return {'shin' + side: 1}
    if base == 'foot' or base.startswith('toe'):
        return {'foot' + side: 1}
    return {'head': 1}  # neck03, head, jaw, eyes and every muscle of the face


def collapse(mh_weights, count):
    """MakeHuman's per-bone weights -> a (count, 16) table for our bones."""
    W = np.zeros((count, len(BONES)))
    for bone, pairs in mh_weights.items():
        if not pairs:
            continue
        share = bone_share(bone)
        arr = np.array(pairs)
        idx = arr[:, 0].astype(np.int64)
        for ours, k in share.items():
            np.add.at(W[:, BI[ours]], idx, arr[:, 1] * k)
    return W


def top4(W):
    order = np.argsort(-W, axis=1)[:, :4]
    w = np.take_along_axis(W, order, axis=1)
    s = w.sum(axis=1, keepdims=True)
    s[s == 0] = 1
    w = w / s
    # as bytes that add up to exactly 255
    b = np.floor(w * 255 + 0.5).astype(np.int64)
    b[:, 0] += 255 - b.sum(axis=1)
    order = np.where(b > 0, order, 0)
    return order.astype(np.uint8), b.astype(np.uint8)


# ------------------------------------------------------------------- meshes
def rodrigues(axis, angle):
    a = axis / np.linalg.norm(axis)
    K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + np.sin(angle) * K + (1 - np.cos(angle)) * (K @ K)


def curl_fingers(body, joints, mh_weights, skel):
    """Relax the hands: MakeHuman models them flat, and nobody holds them so."""
    out = body.copy()
    for side in ('L', 'R'):
        k2, k5 = joints[f'finger2-1.{side}____head'], joints[f'finger5-1.{side}____head']
        wrist, k3 = joints[f'wrist.{side}____head'], joints[f'finger3-1.{side}____head']
        along = k3 - wrist
        palm = np.cross(k5 - k2, along)
        palm /= np.linalg.norm(palm)
        if palm[1] > 0:  # the palms face down and in
            palm = -palm
        for finger, bends in ((1, (0.0, 0.25, 0.3)), (2, (0.3, 0.5, 0.3)), (3, (0.4, 0.6, 0.35)),
                              (4, (0.5, 0.65, 0.4)), (5, (0.55, 0.7, 0.4))):
            M = np.eye(4)
            for seg, bend in zip((1, 2, 3), bends):
                name = f'finger{finger}-{seg}.{side}'
                if name not in skel['bones']:
                    continue
                head, tail = joints[f'{name}____head'], joints[f'{name}____tail']
                # carry the joint along with the bends nearer the palm
                h = (M @ np.append(head, 1))[:3]
                t = (M @ np.append(tail, 1))[:3]
                d = (t - h) / np.linalg.norm(t - h)
                axis = np.cross(d, palm)
                if np.linalg.norm(axis) > 1e-6 and bend:
                    R = rodrigues(axis, bend)
                    T = np.eye(4)
                    T[:3, :3] = R
                    T[:3, 3] = h - R @ h
                    M = T @ M
                pairs = mh_weights.get(name)
                if not pairs:
                    continue
                arr = np.array(pairs)
                idx = arr[:, 0].astype(np.int64)
                w = arr[:, 1][:, None]
                moved = (np.c_[body[idx], np.ones(len(idx))] @ M.T)[:, :3]
                out[idx] += (moved - body[idx]) * w
    return out


def components(n, faces):
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for f in faces:
        r = find(f[0][0])
        for c in f[1:]:
            q = find(c[0])
            if q != r:
                parent[q] = r
    return np.array([find(i) for i in range(n)])


def to_ours(p, scale, ground):
    """MakeHuman (x to its left, y up, z forward, decimetres) -> ours."""
    return np.stack([-p[:, 0] * scale, p[:, 2] * scale, (p[:, 1] - ground) * scale], axis=1)


class Mesh:
    """Vertices split where the texture is cut, with triangles."""

    def __init__(self, name, pos, uv, faces, W, keep=None):
        self.name = name
        corner = {}
        self.src = []
        tris = []
        self.tag = []
        for fi, f in enumerate(faces):
            if keep is not None and not keep[fi]:
                continue
            ids = []
            for c in f:
                if c not in corner:
                    corner[c] = len(self.src)
                    self.src.append(c)
                ids.append(corner[c])
            for k in range(1, len(ids) - 1):
                tris.append((ids[0], ids[k], ids[k + 1]))
                self.tag.append(fi)
        self.src = np.array(self.src, dtype=np.int64).reshape(-1, 2)
        self.tris = np.array(tris, dtype=np.int64).reshape(-1, 3)
        self.tag = np.array(self.tag, dtype=np.int64)
        self.pos = pos[self.src[:, 0]]
        self.uv = uv[self.src[:, 1]] if len(uv) else np.zeros((len(self.src), 2))
        self.W = W[self.src[:, 0]]
        # smooth normals, shared across the texture cuts
        n = np.zeros_like(pos)
        a, b, c = (self.src[self.tris[:, k], 0] for k in range(3))
        fn = np.cross(pos[b] - pos[a], pos[c] - pos[a])
        for k in (a, b, c):
            np.add.at(n, k, fn)
        n = n[self.src[:, 0]]
        ln = np.linalg.norm(n, axis=1, keepdims=True)
        ln[ln == 0] = 1
        self.normal = n / ln
        self.groups = []

    def order_by(self, labels, names):
        """Sort the triangles by a label so each label is one run of the index."""
        order = np.argsort(labels, kind='stable')
        self.tris = self.tris[order]
        self.tag = self.tag[order]
        labels = labels[order]
        self.groups = []
        for i, nm in enumerate(names):
            idx = np.nonzero(labels == i)[0]
            if len(idx):
                self.groups.append({'name': nm, 'start': int(idx[0]) * 3, 'count': int(len(idx)) * 3})


def main():
    data, pack, out = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(out, exist_ok=True)
    T = os.path.join(data, 'targets', 'macrodetails')

    body, body_uv, faces, groups = read_obj(os.path.join(data, '3dobjs', 'base.obj'))
    # a young man of no one ancestry, a little more muscle than average
    for name, k in (('african-male-young', 1 / 3), ('asian-male-young', 1 / 3), ('caucasian-male-young', 1 / 3),
                    ('universal-male-young-maxmuscle-averageweight', 0.3)):
        idx, off = read_target(os.path.join(T, name + '.target'))
        body[idx] += off * k

    skel = json.load(open(os.path.join(data, 'rigs', 'default.mhskel')))
    mh_weights = json.load(open(os.path.join(data, 'rigs', 'default_weights.mhw')))['weights']

    def joint_table(b):
        return {k: b[np.array(v, dtype=np.int64)].mean(axis=0) for k, v in skel['joints'].items()}

    body = curl_fingers(body, joint_table(body), mh_weights, skel)
    joints = joint_table(body)
    W = collapse(mh_weights, len(body))

    def J(bone, end='head'):
        b = skel['bones'][bone]
        return joints[b[end]]

    # ---- what is worn
    suit = read_mhclo(os.path.join(pack, 'clothes', 'male_casualsuit01', 'male_casualsuit01.mhclo'))
    shoes = read_mhclo(os.path.join(pack, 'clothes', 'shoes05', 'shoes05.mhclo'))
    eyes = read_mhclo(os.path.join(pack, 'eyes', 'low-poly', 'low-poly.mhclo'))
    brows = read_mhclo(os.path.join(pack, 'eyebrows', 'eyebrow001', 'eyebrow001.mhclo'))
    lashes = read_mhclo(os.path.join(pack, 'eyelashes', 'eyelashes01', 'eyelashes01.mhclo'))
    hair = read_mhclo(os.path.join(pack, 'hair', 'short02', 'short02.mhclo'))

    def fitted(clo, folder, own_weights=True):
        _, uv, f, _ = read_obj(os.path.join(folder, clo['obj']))
        pos, idx, w = fit(clo, body)
        assert len(pos) == max(c[0] for face in f for c in face) + 1, folder
        Wc = (W[idx] * w[:, :, None]).sum(axis=1)
        if own_weights and clo['weights_file']:
            own = json.load(open(os.path.join(folder, clo['weights_file'])))['weights']
            Wc = collapse(own, len(pos))
        return pos, uv, f, Wc

    suit_pos, suit_uv, suit_f, suit_W = fitted(suit, os.path.join(pack, 'clothes', 'male_casualsuit01'))
    shoe_pos, shoe_uv, shoe_f, shoe_W = fitted(shoes, os.path.join(pack, 'clothes', 'shoes05'))
    eye_pos, eye_uv, eye_f, eye_W = fitted(eyes, os.path.join(pack, 'eyes', 'low-poly'))
    brow_pos, brow_uv, brow_f, brow_W = fitted(brows, os.path.join(pack, 'eyebrows', 'eyebrow001'))
    lash_pos, lash_uv, lash_f, lash_W = fitted(lashes, os.path.join(pack, 'eyelashes', 'eyelashes01'))
    hair_pos, hair_uv, hair_f, hair_W = fitted(hair, os.path.join(pack, 'hair', 'short02'))

    # ---- scale and stand it on the ground
    is_body = np.array([g == 'body' for g in groups])
    body_verts = np.unique([c[0] for f, g in zip(faces, groups) if g == 'body' for c in f])
    crown, sole = body[body_verts, 1].max(), body[body_verts, 1].min()
    scale = HEIGHT / (crown - sole)
    ground = shoe_pos[:, 1].min()

    def ours(p):
        return to_ours(p, scale, ground)

    # The suit is one welded mesh: shirt, trousers and a pair of brown shoes.
    # Its texture is cut into separate pieces, though, and each piece is one
    # garment. The shoes go; shirt and trousers are told apart by height.
    piece = components(len(suit_uv), [[(c[1], 0) for c in f] for f in suit_f])
    sp = ours(suit_pos)
    face_piece = np.array([piece[f[0][1]] for f in suit_f])
    piece_z = {}
    for f in suit_f:
        z = piece_z.setdefault(piece[f[0][1]], [])
        z.extend(sp[c[0], 2] for c in f)
    comp_kind = {}
    for c, z in piece_z.items():
        z = np.array(z)
        comp_kind[c] = 'shoes' if z.max() < 0.25 else 'trousers' if z.mean() < 0.95 else 'shirt'
    suit_keep = [comp_kind[c] != 'shoes' for c in face_piece]
    comp = None

    hidden = np.zeros(len(body), dtype=bool)
    hidden[list(suit['delete'] | shoes['delete'])] = True
    keep = [g == 'body' and not all(hidden[c[0]] for c in f) for f, g in zip(faces, groups)]

    bp = ours(body)
    m_body = Mesh('body', bp, body_uv, faces, W, keep)
    # hands apart from the head, so that gloves can replace them
    dom = np.argmax(m_body.W, axis=1)
    hand_like = np.isin(dom, [BI[b] for b in ('armL', 'foreL', 'handL', 'armR', 'foreR', 'handR')])
    tri_hand = hand_like[m_body.tris].sum(axis=1) >= 2
    tri_left = m_body.pos[m_body.tris[:, 0], 0] < 0
    m_body.order_by(np.where(tri_hand, np.where(tri_left, 1, 2), 0), ['head', 'handL', 'handR'])

    m_suit = Mesh('suit', sp, suit_uv, suit_f, suit_W, suit_keep)
    # shirt apart from trousers, so that an umpire can wear dark ones
    is_trousers = np.array([comp_kind[face_piece[fi]] == 'trousers' for fi in m_suit.tag])
    m_suit.order_by(is_trousers.astype(np.int64), ['shirt', 'trousers'])
    m_shoes = Mesh('shoes', ours(shoe_pos), shoe_uv, shoe_f, shoe_W)
    m_eyes = Mesh('eyes', ours(eye_pos), eye_uv, eye_f, eye_W)
    m_brows = Mesh('brows', ours(brow_pos), brow_uv, brow_f, brow_W)
    m_lashes = Mesh('lashes', ours(lash_pos), lash_uv, lash_f, lash_W)
    m_hair = Mesh('hair', ours(hair_pos), hair_uv, hair_f, hair_W)
    for m in (m_eyes, m_brows, m_lashes, m_hair):  # they belong to the head, all of them
        m.W[:] = 0
        m.W[:, BI['head']] = 1
    meshes = [m_body, m_suit, m_shoes, m_eyes, m_brows, m_lashes, m_hair]

    # ---- the joints the solver needs
    def pt(v):
        return ours(np.array([v]))[0]

    rig = {}
    for s in ('L', 'R'):
        rig['hip' + s] = pt(J(f'upperleg01.{s}'))
        rig['knee' + s] = pt(J(f'lowerleg01.{s}'))
        rig['ankle' + s] = pt(J(f'foot.{s}'))
        rig['ball' + s] = pt((J(f'toe1-1.{s}') + J(f'toe5-1.{s}')) / 2)
        rig['toe' + s] = pt(J(f'toe2-1.{s}', 'tail'))
        rig['shoulder' + s] = pt(J(f'upperarm01.{s}'))
        rig['elbow' + s] = pt(J(f'lowerarm01.{s}'))
        rig['wrist' + s] = pt(J(f'wrist.{s}'))
        rig['knuckle' + s] = pt(J(f'finger3-1.{s}'))
        rig['index' + s] = pt(J(f'finger2-1.{s}'))
        rig['little' + s] = pt(J(f'finger5-1.{s}'))
    # the skull: everything that moves only with the head, above the jaw line
    head_only = (W[:, BI['head']] > 0.98) & np.isin(np.arange(len(body)), body_verts)
    hp = bp[head_only]
    eye_c = ours(eye_pos).mean(axis=0)
    skull = hp[hp[:, 2] > eye_c[2] - 0.035]
    rig['headMin'] = hp.min(axis=0)
    rig['headMax'] = hp.max(axis=0)
    rig['skullMin'] = skull.min(axis=0)
    rig['skullMax'] = skull.max(axis=0)
    rig['eyes'] = eye_c
    rig['chin'] = hp[np.argmin(hp[:, 2] - hp[:, 1] * 0.5)]
    rig['crown'] = np.array([0, hp[np.argmax(hp[:, 2]), 1], hp[:, 2].max()])
    rig['neck'] = pt(J('neck01'))
    rig['headJoint'] = pt(J('head'))

    # make it exactly symmetric, so left and right limbs are one length
    for k in list(rig):
        if k.endswith('L'):
            l, r = rig[k], rig[k[:-1] + 'R']
            m = np.array([(l[0] - r[0]) / 2, (l[1] + r[1]) / 2, (l[2] + r[2]) / 2])
            rig[k] = m
            rig[k[:-1] + 'R'] = np.array([-m[0], m[1], m[2]])

    def d(a, b):
        return float(np.linalg.norm(rig[a] - rig[b]))

    palm = (rig['wristL'] + rig['knuckleL']) / 2
    hip_c = (rig['hipL'] + rig['hipR']) / 2
    chest_c = (rig['shoulderL'] + rig['shoulderR']) / 2
    measure = {
        'thigh': d('hipL', 'kneeL'), 'shin': d('kneeL', 'ankleL'), 'ankle': float(rig['ankleL'][2]),
        'ballOfFoot': float(np.linalg.norm((rig['ballL'] - rig['ankleL'])[:2])),
        'spine': float(np.linalg.norm(chest_c - hip_c)),
        'hipHalf': float(abs(rig['hipL'][0])), 'shoulderHalf': float(abs(rig['shoulderL'][0])),
        'upperArm': d('shoulderL', 'elbowL'), 'foreArm': float(np.linalg.norm(palm - rig['elbowL'])),
        'height': float(max(m.pos[:, 2].max() for m in (m_body, m_hair))),
        'crown': float(rig['crown'][2]),
    }

    # ---- write
    blob = bytearray()

    def put(arr):
        while len(blob) % 4:
            blob.append(0)
        start = len(blob)
        blob.extend(arr.tobytes())
        return start

    manifest = {'bones': BONES, 'rig': {k: [round(float(x), 5) for x in v] for k, v in rig.items()},
                'measure': {k: round(v, 4) for k, v in measure.items()}, 'meshes': {}}
    for m in meshes:
        idx, wt = top4(m.W)
        big = len(m.pos) > 65535
        manifest['meshes'][m.name] = {
            'vertices': int(len(m.pos)), 'triangles': int(len(m.tris)),
            'position': put(m.pos.astype('<f4')),
            'normal': put(np.clip(np.round(m.normal * 127), -127, 127).astype(np.int8)),
            'uv': put(m.uv.astype('<f4')),
            'skinIndex': put(idx), 'skinWeight': put(wt),
            'index': put(m.tris.astype('<u4' if big else '<u2')), 'index32': big,
            'groups': m.groups,
        }
    with open(os.path.join(out, 'figure.bin'), 'wb') as f:
        f.write(bytes(blob))

    textures(pack, out, m_suit, {fi: comp_kind[face_piece[fi]] for fi in np.unique(m_suit.tag)})
    manifest['textures'] = {
        'skin': ['skin-light.jpg', 'skin-olive.jpg', 'skin-dark.jpg'],
        'whites': 'whites.jpg', 'whitesNormal': 'whites-normal.jpg', 'shoes': 'shoes.jpg',
        'eyes': 'eyes.png', 'brows': 'brows.png', 'lashes': 'lashes.png', 'hair': 'hair.png',
    }
    with open(os.path.join(out, 'figure.json'), 'w') as f:
        json.dump(manifest, f, separators=(',', ':'))
        f.write('\n')

    print('scale', round(scale, 5), 'sole thickness', round((sole - ground) * scale, 4))
    for k, v in manifest['measure'].items():
        print(f'  {k:13s}{v}')
    for k in ('hipL', 'kneeL', 'ankleL', 'ballL', 'toeL', 'shoulderL', 'elbowL', 'wristL', 'knuckleL', 'indexL',
              'littleL', 'neck', 'headJoint', 'eyes', 'chin', 'crown', 'headMin', 'headMax', 'skullMin', 'skullMax'):
        print(f'  {k:13s}{np.round(rig[k], 3)}')
    for m in meshes:
        print(f'  {m.name:8s}{len(m.pos):6d} vertices {len(m.tris):6d} triangles', m.groups)
    print('  figure.bin', len(blob), 'bytes')


# ----------------------------------------------------------------- textures
def textures(pack, out, m_suit, kind_of_face):
    S = 1024
    # cricket whites out of a navy shirt and blue jeans: keep the weave, the
    # seams and the creases, lose the colour and the fading
    src = os.path.join(pack, 'clothes', 'male_casualsuit01')
    dif = Image.open(os.path.join(src, 'male_casualsuit01_diffuse.png')).convert('RGB').resize((S, S), Image.LANCZOS)
    ao = Image.open(os.path.join(src, 'male_casualsuit01_ao.png')).convert('L').resize((S, S), Image.LANCZOS)
    lum = np.asarray(dif.convert('L'), dtype=np.float64) / 255
    wide = np.asarray(dif.convert('L').filter(ImageFilter.GaussianBlur(14)), dtype=np.float64) / 255
    detail = np.clip(lum / np.maximum(wide, 0.02), 0.4, 1.6)
    # which part of the picture is trousers
    mask = Image.new('L', (S, S), 0)
    draw = ImageDraw.Draw(mask)
    for fi in np.unique(m_suit.tag):
        kind = kind_of_face[fi]
        tri = m_suit.tris[m_suit.tag == fi]
        for t in tri:
            pts = [(float(m_suit.uv[i, 0]) * S, (1 - float(m_suit.uv[i, 1])) * S) for i in t]
            draw.polygon(pts, fill=255 if kind == 'trousers' else 128, outline=255 if kind == 'trousers' else 128)
    mask = np.asarray(mask.filter(ImageFilter.MaxFilter(5)), dtype=np.float64)
    trousers = (mask > 200)[:, :, None]
    shade = 0.7 + 0.3 * (np.asarray(ao, dtype=np.float64) / 255)
    tone = (0.62 + 0.38 * detail)[:, :, None] * shade[:, :, None]
    shirt_col = np.array([233, 231, 224], dtype=np.float64)
    trouser_col = np.array([229, 226, 217], dtype=np.float64)
    rgb = np.where(trousers, trouser_col, shirt_col) * np.clip(tone, 0, 1.06)
    Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8)).save(os.path.join(out, 'whites.jpg'), quality=86)
    nrm = Image.open(os.path.join(src, 'male_casualsuit01_normal.png')).convert('RGB').resize((S, S), Image.LANCZOS)
    nrm.save(os.path.join(out, 'whites-normal.jpg'), quality=90)

    for name, folder, file in (('skin-light', 'young_caucasian_male', 'young_lightskinned_male_diffuse.png'),
                               ('skin-olive', 'young_asian_male', 'young_lightskinned_male_diffuse3.png'),
                               ('skin-dark', 'young_african_male', 'young_darkskinned_male_diffuse.png')):
        im = Image.open(os.path.join(pack, 'skins', folder, file)).convert('RGB').resize((S, S), Image.LANCZOS)
        im.save(os.path.join(out, name + '.jpg'), quality=86)

    # white boots: the trainers with their green trim taken out
    im = Image.open(os.path.join(pack, 'clothes', 'shoes05', 'shoes05_diffuse.png')).convert('RGB').resize((512, 512), Image.LANCZOS)
    a = np.asarray(im, dtype=np.float64) / 255
    g = a.mean(axis=2, keepdims=True)
    a = np.clip(0.2 + g * 1.05 + (a - g) * 0.15, 0, 1) ** 0.8
    Image.fromarray((a * 255).astype(np.uint8)).save(os.path.join(out, 'shoes.jpg'), quality=86)

    Image.open(os.path.join(pack, 'eyes', 'materials', 'brown_eye.png')).convert('RGBA').resize((256, 256), Image.LANCZOS).save(os.path.join(out, 'eyes.png'), optimize=True)
    Image.open(os.path.join(pack, 'eyebrows', 'eyebrow001', 'eyebrow001.png')).convert('RGBA').resize((256, 256), Image.LANCZOS).save(os.path.join(out, 'brows.png'), optimize=True)
    Image.open(os.path.join(pack, 'eyelashes', 'eyelashes01', 'eyelashes01.png')).convert('RGBA').resize((256, 256), Image.LANCZOS).save(os.path.join(out, 'lashes.png'), optimize=True)
    Image.open(os.path.join(pack, 'hair', 'short02', 'short02_diffuse.png')).convert('RGBA').resize((512, 512), Image.LANCZOS).save(os.path.join(out, 'hair.png'), optimize=True)


if __name__ == '__main__':
    main()
