import * as THREE from "three";

export function disposeObject(object: THREE.Object3D): void {
  disposeObjects([object]);
}

function disposeObjects(objects: THREE.Object3D[]): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  for (const object of objects)
    object.traverse((child) => {
      const rendered = child as THREE.Mesh;
      if (rendered.geometry) geometries.add(rendered.geometry);
      if (rendered.material)
        for (const material of Array.isArray(rendered.material)
          ? rendered.material
          : [rendered.material])
          materials.add(material);
    });
  for (const geometry of geometries) {
    (
      geometry as THREE.BufferGeometry & { disposeBoundsTree?: () => void }
    ).disposeBoundsTree?.();
    geometry.dispose();
  }
  for (const material of materials) material.dispose();
}

export class OverlayScenes {
  private readonly groups = new Map<string, THREE.Group>();
  constructor(
    private readonly scene: THREE.Scene,
    private readonly invalidate: () => void,
  ) {}

  hasScene(name: string): boolean {
    return this.groups.has(name);
  }
  addScene(name: string): THREE.Group {
    if (!name.trim()) throw new Error("An overlay name is required.");
    let group = this.groups.get(name);
    if (!group) {
      group = new THREE.Group();
      group.name = name;
      this.groups.set(name, group);
      this.scene.add(group);
      this.invalidate();
    }
    return group;
  }
  addObject(object: THREE.Object3D, name: string): void {
    this.addScene(name).add(object);
    this.invalidate();
  }
  addMesh(mesh: THREE.Mesh, name: string): void {
    this.addObject(mesh, name);
  }
  removeMesh(mesh: THREE.Object3D, name: string, dispose = false): void {
    const group = this.groups.get(name);
    if (mesh.parent !== group) return;
    group.remove(mesh);
    if (dispose) disposeObject(mesh);
    this.invalidate();
  }
  clearScene(name: string, dispose = false): void {
    const group = this.groups.get(name);
    if (!group) return;
    for (const child of [...group.children]) {
      group.remove(child);
      if (dispose) disposeObject(child);
    }
    this.invalidate();
  }
  setVisible(name: string, visible: boolean): void {
    const group = this.groups.get(name);
    if (group) {
      group.visible = visible;
      this.invalidate();
    }
  }
  removeScene(name: string, dispose = false): void {
    const group = this.groups.get(name);
    if (!group) return;
    this.clearScene(name, dispose);
    group.removeFromParent();
    this.groups.delete(name);
    this.invalidate();
  }
  dispose(): void {
    disposeObjects([...this.groups.values()]);
    for (const group of this.groups.values()) {
      group.removeFromParent();
      group.clear();
    }
    this.groups.clear();
    this.invalidate();
  }
}
