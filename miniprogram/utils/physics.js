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
const FRICTION = 0.4;

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

  const dynamicBody = new CANNON.Body({
    mass: 1,
    shape: new CANNON.Box(
      new CANNON.Vec3(halfExtents.x, halfExtents.y, halfExtents.z)
    ),
    material: toyMaterial,
    position: new CANNON.Vec3(startPosition.x, startPosition.y, startPosition.z),
  });
  world.addBody(dynamicBody);

  return { world, groundBody, dynamicBody };
}

function stepWorld(world, fixedDeltaTime) {
  world.step(fixedDeltaTime);
}

module.exports = {
  createPhysicsWorld,
  stepWorld,
};
