Page({
  data: {
    tempFilePath: '',
    uploading: false,
  },

  onChooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: (res) => {
        this.setData({ tempFilePath: res.tempFiles[0].tempFilePath });
      },
    });
  },

  onUpload() {
    if (!this.data.tempFilePath || this.data.uploading) {
      return;
    }
    this.setData({ uploading: true });

    const cloudPath = `captures/${Date.now()}-${Math.floor(Math.random() * 1e6)}.jpg`;
    wx.cloud.uploadFile({
      cloudPath,
      filePath: this.data.tempFilePath,
      success: (res) => {
        // Phase 2 TODO: this is where the "generate 3D model" cloud function
        // call slots in -- pass res.fileID to the generation pipeline
        // (background removal -> image-to-3D -> simplification -> convex hull
        // -> GLB packaging; see README for the service recommendation), then
        // navigate to the viewer with the resulting model's fileID instead of
        // just the source image's.
        wx.redirectTo({
          url: `/pages/viewer/viewer?imageFileID=${encodeURIComponent(res.fileID)}`,
        });
      },
      fail: (err) => {
        console.error('[capture] upload failed:', err);
        wx.showToast({ title: '上传失败，请重试', icon: 'none' });
      },
      complete: () => {
        this.setData({ uploading: false });
      },
    });
  },
});
