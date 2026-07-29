// generateModel -- Phase 2 pipeline entry point (currently a STUB).
//
// Input:  { imageFileID }  cloud-storage fileID of the user's uploaded photo
// Output: { ok, modelFileID, stub }  fileID of a generated GLB in cloud storage
//
// Stub behavior: ignores the image content and uploads a bundled placeholder
// GLB (the same Khronos Duck sample the client ships) to models/, so the
// entire mechanical flow -- capture, upload, function call, storage, viewer
// loading a REMOTE model -- is exercised end-to-end before any AI service is
// integrated.
//
// Phase 2 TODO (real implementation, replacing everything between the
// markers below): call Tencent Hunyuan 3D (混元生3D, 极速版) --
//   1. cloud.downloadFile(imageFileID) to get the photo bytes
//   2. submit an image-to-3D task via the Tencent Cloud SDK (async task API)
//   3. poll task status until done (or split submit/poll into two functions
//      if this one risks hitting the cloud-function execution time limit)
//   4. download the resulting GLB, optionally post-process (mesh
//      simplification, convex hull for the physics proxy)
//   5. upload the GLB + hull to cloud storage and return their fileIDs
// Credentials (SecretId/SecretKey) must live in cloud-function env variables
// (console: 云函数 -> 配置 -> 环境变量), never in client code or this repo.
const cloud = require('wx-server-sdk');
const fs = require('fs');
const path = require('path');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const imageFileID = (event && event.imageFileID) || '';
  if (!imageFileID) {
    return { ok: false, error: 'imageFileID is required' };
  }

  // ---- STUB START (replace with real generation, see header comment) ----
  const glbBuffer = fs.readFileSync(path.join(__dirname, 'placeholder.glb'));
  const uploadRes = await cloud.uploadFile({
    cloudPath: `models/${Date.now()}-${Math.floor(Math.random() * 1e6)}.glb`,
    fileContent: glbBuffer,
  });
  // ---- STUB END ----

  return {
    ok: true,
    stub: true,
    modelFileID: uploadRes.fileID,
    imageFileID,
  };
};
