"""Build a simple gear part in a fresh Blender scene for the README demo.

Run from Blender's Python Console with:
    exec(open(r"<repo>\\demo\\gear.py", encoding="utf-8").read())
"""

import bpy
import bmesh
import math


def build_gear(scene, teeth=16, r_root=0.88, r_tip=1.12, depth=0.26, bore=0.28):
    bm = bmesh.new()
    pitch = 2.0 * math.pi / teeth
    profile = []
    for index in range(teeth):
        angle = index * pitch
        for radius, offset in (
            (r_root, -0.32),
            (r_tip, -0.14),
            (r_tip, 0.14),
            (r_root, 0.32),
        ):
            point = angle + offset * pitch
            profile.append((radius * math.cos(point), radius * math.sin(point)))

    top = [bm.verts.new((x, y, depth / 2)) for x, y in profile]
    bottom = [bm.verts.new((x, y, -depth / 2)) for x, y in profile]
    bm.verts.ensure_lookup_table()

    top_face = bm.faces.new(top)
    bottom_face = bm.faces.new(list(reversed(bottom)))
    for index in range(len(profile)):
        nxt = (index + 1) % len(profile)
        bm.faces.new((top[index], top[nxt], bottom[nxt], bottom[index]))

    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bmesh.ops.triangulate(
        bm,
        faces=[top_face, bottom_face],
        quad_method="BEAUTY",
        ngon_method="BEAUTY",
    )

    mesh = bpy.data.meshes.new("Gear")
    bm.to_mesh(mesh)
    bm.free()
    gear = bpy.data.objects.new("Gear", mesh)
    scene.collection.objects.link(gear)

    bpy.ops.mesh.primitive_cylinder_add(
        vertices=64, radius=bore, depth=depth * 4, location=(0, 0, 0)
    )
    cutter = bpy.context.object
    boolean = gear.modifiers.new("Bore", "BOOLEAN")
    boolean.operation = "DIFFERENCE"
    boolean.solver = "EXACT"
    boolean.object = cutter
    bpy.context.view_layer.objects.active = gear
    gear.select_set(True)
    bpy.ops.object.modifier_apply(modifier=boolean.name)
    bpy.data.objects.remove(cutter, do_unlink=True)

    bevel = gear.modifiers.new("Bevel", "BEVEL")
    bevel.width = 0.014
    bevel.segments = 2
    bevel.limit_method = "ANGLE"
    bpy.ops.object.modifier_apply(modifier=bevel.name)

    material = bpy.data.materials.new("Gear Steel")
    material.use_nodes = True
    bsdf = next(
        (node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"),
        None,
    )
    if bsdf is None:
        raise RuntimeError("Principled BSDF node was not created")
    bsdf.inputs["Base Color"].default_value = (0.72, 0.43, 0.13, 1.0)
    bsdf.inputs["Metallic"].default_value = 0.92
    bsdf.inputs["Roughness"].default_value = 0.26
    gear.data.materials.append(material)

    try:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(32))
    except Exception:
        for polygon in gear.data.polygons:
            polygon.use_smooth = True

    gear.select_set(False)
    bpy.context.view_layer.objects.active = gear
    return gear


def add_area(scene, name, location, energy, color, size, target):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.color = color
    data.size = size
    light = bpy.data.objects.new(name, data)
    scene.collection.objects.link(light)
    light.location = location
    track = light.constraints.new("TRACK_TO")
    track.target = target
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"
    return light


def configure_view():
    """Switch the 3D view to the camera and a clean material preview."""
    screen = bpy.context.screen
    if screen is not None:
        for area in screen.areas:
            if area.type != "VIEW_3D":
                continue
            space = area.spaces.active
            space.shading.type = "MATERIAL"
            space.region_3d.view_perspective = "CAMERA"
            space.overlay.show_floor = False
            space.overlay.show_axis_x = False
            space.overlay.show_axis_y = False
            space.overlay.show_cursor = False
            space.overlay.show_extras = False
            return None
    state = getattr(configure_view, "tries", 0) + 1
    configure_view.tries = state
    return 0.2 if state < 60 else None


window = bpy.context.window
base = bpy.data.scenes.get("Scene")
if base is None or base.name.startswith("Gear Demo"):
    base = next((item for item in bpy.data.scenes if not item.name.startswith("Gear Demo")), None)
if window is not None and base is not None:
    window.scene = base
for old in [item for item in list(bpy.data.scenes) if item.name.startswith("Gear Demo")]:
    bpy.data.scenes.remove(old)

scene = bpy.data.scenes.new("Gear Demo")
if window is not None:
    window.scene = scene

gear = build_gear(scene)

target = bpy.data.objects.new("Target", None)
scene.collection.objects.link(target)
target_location = (0, 0, 0.02)
target.location = target_location

camera_data = bpy.data.cameras.new("Camera")
camera = bpy.data.objects.new("Camera", camera_data)
scene.collection.objects.link(camera)
camera.location = (3.5, -4.3, 3.4)
camera.data.lens = 55
track = camera.constraints.new("TRACK_TO")
track.target = target
track.track_axis = "TRACK_NEGATIVE_Z"
track.up_axis = "UP_Y"
scene.camera = camera

add_area(scene, "Key", (3.5, -2.5, 5.0), 1600, (1.0, 0.94, 0.86), 5.0, target)
add_area(scene, "Fill", (-4.0, 1.5, 3.0), 550, (0.72, 0.84, 1.0), 5.0, target)
add_area(scene, "Rim", (0.5, 4.0, 3.2), 900, (0.68, 0.88, 1.0), 4.0, target)

world = bpy.data.worlds.new("Gear World")
world.use_nodes = True
background = next(
    (node for node in world.node_tree.nodes if node.type == "BACKGROUND"),
    None,
)
if background is not None:
    background.inputs["Color"].default_value = (0.012, 0.018, 0.028, 1)
    background.inputs["Strength"].default_value = 0.8
scene.world = world

try:
    scene.render.engine = "BLENDER_EEVEE_NEXT"
except Exception:
    scene.render.engine = "BLENDER_EEVEE"

if not bpy.app.timers.is_registered(configure_view):
    bpy.app.timers.register(configure_view, first_interval=0.2)

print("Gear ready:", len(gear.data.vertices), "vertices,", len(gear.data.polygons), "faces")
