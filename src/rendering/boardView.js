// Board view — the cube's coordinate system, and (in later slices) the 98 tiles, the pose
// and the opening wave.
//
// Refactor P3a (temp/VoxalBlast-渐进式模块拆分重构执行计划.md §2 `boardView.js`). This slice
// is only the coordinate half, because that half has a job of its own: the plan calls out
// "cubeVector 与局部/世界坐标转换 | boardView | 统一给 input/pieceView 用，**禁止复制公式**".
// Every consumer that needs to turn a face cell into a place on screen — the landing preview,
// the drag ghost's face basis, the item overlay, the rocket's line picker, the intro's
// per-tile placement and the `placement()` read-out — goes through these functions, and none
// of them may grow its own copy. `pieceView` (P4) and `gameInput` (P7) are the next two
// callers, which is exactly why this moves before them.
//
// `metrics` and `getCubeGroup` are LAZY getters for the same reason as in gameScene.js: the
// pitch and half-side are the BOARD's arithmetic and stay in main's constants (the plan
// forbids a second copy of the lattice mapping here), while the group is assembled by main.
import * as THREE from 'three'
import { faceLattice } from '../game/board.js'

export function createBoardView({ metrics, getCubeGroup }) {
  // Per-face placement plane in cube-local space. n = outward face normal,
  // u/v = the in-plane axes matching the board's face->lattice mapping.
  const FACE_PLANE = {
    '+x': { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
    '-x': { n: [-1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
    '+y': { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    '-y': { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    '+z': { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    '-z': { n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0] },
  }

  // A fresh Vector3 per call, deliberately: callers hand the result straight to
  // `applyQuaternion` / `multiplyScalar` / `addScaledVector` and would corrupt a shared one.
  function cubeVector(face, axis) {
    const b = FACE_PLANE[face]
    if (axis === 'n') return new THREE.Vector3(...b.n)
    if (axis === 'u') return new THREE.Vector3(...b.u)
    return new THREE.Vector3(...b.v)
  }

  // World-space lattice cell -> 3D position (cells are flush on the shell).
  function cellToWorld(x, y, z) {
    const { cs, half } = metrics()
    return new THREE.Vector3(
      x * cs - half + cs / 2,
      y * cs - half + cs / 2,
      z * cs - half + cs / 2,
    )
  }

  // Cube-local position of a face cell (from its lattice coordinate).
  function cellLocal(face, u, v) {
    const [x, y, z] = faceLattice(face, u, v)
    return cellToWorld(x, y, z)
  }

  // Center of a face's placement plane (the outer shell surface), cube-local.
  function facePlaneLocalCenter(face) {
    return cubeVector(face, 'n').multiplyScalar(metrics().half)
  }

  // The same cell in WORLD space, which is what the projected/screen-space consumers need.
  // It has to read the group through the getter every call: the cube rotates, and a cached
  // matrix would freeze the landing marker to the pose it was first drawn at.
  function cellWorld(face, u, v) {
    return cellLocal(face, u, v).applyMatrix4(getCubeGroup().matrixWorld)
  }

  return { FACE_PLANE, cubeVector, cellToWorld, cellLocal, cellWorld, facePlaneLocalCenter }
}
