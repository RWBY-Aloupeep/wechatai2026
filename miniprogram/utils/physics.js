// cannon-es physics world for the toy model. Used instead of xr-frame's own
// Beta `rigidbody` attribute, which (per the official docs) only exposes
// mass/useGravity/constraintsMask and addForce/addTorque/sleep/wakeUp -- no
// restitution, no friction, no impulse/set-velocity method. Bounce and
// tap-impulse are hard Phase-1 requirements, so the actual simulation lives
// here; xr-frame is only used for rendering + tap hit-testing.
const CANNON = require('cannon-es');

const GRAVITY = -9.82;
const GROUND_Y = 0;
const RESTITUTION = 0.65;
const FRICTION = 0.6;
// Damping bleeds off residual sliding/tumbling energy after each bounce so
// the body settles in place rather than slowly drifting -- confirmed on a
// real device that without this, the toy can tumble/slide far enough over
// a few bounces (or repeated taps) to drift out of the camera's view.
const LINEAR_DAMPING = 0.4;
const ANGULAR_DAMPING = 0.4;

// Invisible static walls keeping the toy within camera view even after
// many taps, since each tap adds random horizontal velocity with nothing
// otherwise stopping it from eventually wandering off-screen. Not part of
// the visual scene (xr-frame has no corresponding element) -- purely a
// cannon-es containment box centered on the drop origin.
const BOUNDARY_HALF_EXTENT = 2.5;
const BOUNDARY_HEIGHT = 6;

// startPosition: {x, y, z} where the dynamic body begins (its "drop" origin).
// halfExtents: {x, y, z} from utils/proxy-shape.js.
function createPhysicsWorld({ startPosition, halfExtents }) {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, GRAVITY, 0) });

  const groundMaterial = new CANNON.Material('ground');
  const toyMaterial = new CANNON.Material('toy');
  world.addContactMaterial(
    new CANNON.ContactMaterial(groundMaterial, toyMaterial, {
      restitution: RESTITUTION,
      friction: FRICTION,
    })
  );

  const groundBody = new CANNON.Body({
    mass: 0,
    shape: new CANNON.Plane(),
    material: groundMaterial,
  });
  groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  groundBody.position.set(0, GROUND_Y, 0);
  world.addBody(groundBody);

  addBoundaryWalls(world, groundMaterial, startPosition);

  const dynamicBody = new CANNON.Body({
    mass: 1,
    shape: new CANNON.Box(
      new CANNON.Vec3(halfExtents.x, halfExtents.y, halfExtents.z)
    ),
    material: toyMaterial,
    position: new CANNON.Vec3(startPosition.x, startPosition.y, startPosition.z),
    linearDamping: LINEAR_DAMPING,
    angularDamping: ANGULAR_DAMPING,
  });
  world.addBody(dynamicBody);

  return { world, groundBody, dynamicBody };
}

function addBoundaryWalls(world, groundMaterial, startPosition) {
  const half = BOUNDARY_HALF_EXTENT;
  const wallConfigs = [
    { position: [startPosition.x + half, 0, startPosition.z], rotationY: -Math.PI / 2 },
    { position: [startPosition.x - half, 0, startPosition.z], rotationY: Math.PI / 2 },
    { position: [startPosition.x, 0, startPosition.z + half], rotationY: Math.PI },
    { position: [startPosition.x, 0, startPosition.z - half], rotationY: 0 },
  ];

  wallConfigs.forEach(({ position, rotationY }) => {
    const wall = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Plane(),
      material: groundMaterial,
    });
    wall.quaternion.setFromEuler(0, rotationY, 0);
    wall.position.set(position[0], position[1] + BOUNDARY_HEIGHT / 2, position[2]);
    world.addBody(wall);
  });
}

function stepWorld(world, fixedDeltaTime) {
  world.step(fixedDeltaTime);
}

module.exports = {
  createPhysicsWorld,
  stepWorld,
};
