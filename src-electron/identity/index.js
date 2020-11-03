const { app, ipcMain } = require("electron");
const IpfsHttpClient = require("ipfs-http-client");
const all = require("it-all");
const path = require("path");
const fs = require("fs-extra");
const levelup = require("levelup");
const leveldown = require("leveldown");
const encode = require("encoding-down");
const logger = require("../common/logger");

const IDENTITY_TEMPLATE = {
  aux: {},
  av: "",
  dn: "",
  following: [],
  id: "",
  meta: [],
  posts: [],
  ts: 0
};

module.exports = async function(ctx) {
  logger.info("[identity] starting");
  logger.info(ctx);
  let app_data_path = null;
  let follow_storage_path = null;
  let ipfs = null;
  let ipfs_id = null;
  let level_db = null;
  let self = null;
  let feed = null;

  const dbContainsKey = (db, key) => {
    return new Promise(resolve => {
      db.get(key, function(err) {
        if (err) resolve(false);
        resolve(true);
      });
    });
  };

  const init = async () => {
    logger.info("[identity] init");

    // start IpfsHttpClient
    ipfs = IpfsHttpClient({
      host: "localhost",
      port: "5001",
      protocol: "http"
    });
    ipfs_id = await ipfs.id();

    // ensure paths and directories...
    app_data_path = path.join(app.getPath("appData"), "follow");
    if (!fs.existsSync(app_data_path)) {
      fs.mkdirSync(app_data_path);
    }
    follow_storage_path = path.join(app_data_path, "Follow Storage");
    if (!fs.existsSync(follow_storage_path)) {
      fs.mkdirSync(follow_storage_path);
    }

    // ensure db
    level_db = levelup(
      encode(leveldown(follow_storage_path), {
        valueEncoding: "json"
      })
    );

    if (!(await dbContainsKey(level_db, "feed"))) {
      await level_db.put("feed", []);
    }

    if (await dbContainsKey(level_db, ipfs_id.id)) {
      await load();
    } else {
      // first run, initialize new identity...
      self = IDENTITY_TEMPLATE;
      self.following = [ipfs_id.id];
      self.id = ipfs_id.id;
      self.ts = Math.floor(new Date().getTime());
      await save();
    }
  };

  // get id
  ipcMain.on("get-id", async event => {
    if (!ipfs_id) {
      ipfs_id = await ipfs.id();
    }
    event.sender.send("id", ipfs_id);
  });
  ipcMain.handle("get-id", async event => {
    console.log(event);
    if (!ipfs_id) {
      ipfs_id = await ipfs.id();
    }
    return ipfs_id;
  });

  const load = async () => {
    logger.info("load");
    self = await level_db.get(ipfs_id.id);
  };

  const save = async () => {
    logger.info("saving identity...");
    console.log(self);
    self.id = ipfs_id.id;
    await level_db.put(ipfs_id.id, self);
    await publish();
  };

  // publish identity
  const publish = async () => {
    logger.info("[Identity] publish()");
    const temp_self = self;
    delete temp_self.posts_deep;
    const obj = {
      path: "identity.json",
      content: JSON.stringify(temp_self)
    };
    const add_options = {
      pin: true,
      wrapWithDirectory: true,
      timeout: 10000
    };
    const publish_object = await ipfs.add(obj, add_options);
    const publish_result = await ipfs.name.publish(publish_object.cid.string, {
      lifetime: "8760h"
    });
    logger.info("publish complete");
    logger.info(publish_result);
    return publish_result;
  };
  ipcMain.on("publish-identity", async event => {
    const result = await publish();
    event.sender.send("publish-identity-complete", result);
  });
  ipcMain.handle("publish-identity", async () => {
    const result = await publish();
    return result;
  });

  const pinCID = async cid => {
    logger.info(`[Identity] pinCID(${cid})`);
    const pin_result = await ipfs.pin.add(cid);
    // logger.info("pin_result");
    // logger.info(pin_result);
    return pin_result;
  };

  const getIdentityIpfs = async id => {
    logger.info(`[Identity] getIdentityIpfs(${id})`);
    const identity_file_cid = await all(ipfs.name.resolve(id));
    const cid = `${identity_file_cid[0]}/identity.json`;
    // await pinCID(cid);
    const identity_json = Buffer.concat(await all(ipfs.cat(cid)));
    return JSON.parse(identity_json);
  };

  const getIdentity = async id => {
    logger.info(`getIdentity(${id})`);
    let identity_object;
    if (await dbContainsKey(level_db, id)) {
      logger.info("loading identity from DB...");
      identity_object = await level_db.get(id);
    } else {
      logger.info(
        "inserting blank identity into DB. We'll grab the real one when we can..."
      );
      identity_object = IDENTITY_TEMPLATE;
      identity_object.following = [id];
      identity_object.id = id;
      identity_object.ts = Math.floor(new Date().getTime());
      if (id !== ipfs_id.id) {
        await level_db.put(id, identity_object);
      }
    }
    logger.info(identity_object);
    console.log(identity_object);
    return identity_object;
  };
  ipcMain.on("get-identity", async (event, id) => {
    const identity_object = await getIdentity(id);
    delete identity_object.posts_deep;
    event.sender.send("identity", identity_object);
  });
  ipcMain.handle("get-identity", async (event, id) => {
    const identity_object = await getIdentity(id);
    delete identity_object.posts_deep;
    return identity_object;
  });

  // edit identity field
  const editIdentityField = async (event, kv) => {
    logger.info("[Identity] editIdentityField()");
    console.log(kv);
    const key = kv.key;
    const value = kv.value;
    if (typeof self[key] === typeof value) {
      self[key] = value;
      await save();
    }
  };
  ipcMain.on("edit-identity-field", editIdentityField);

  // update followed identities
  const updateFollowing = async () => {
    logger.info("updateFollowing()");
    for await (const id of self.following) {
      try {
        if (id !== ipfs_id.id) {
          const identity_object = await getIdentityIpfs(id);
          if (identity_object.id != id) {
            console.log("Id in identity fraudulent, correcting....");
            console.log(`expected: ${id}, got: ${identity_object["id"]}`);
            identity_object["id"] = id;
          }
          await level_db.put(id, identity_object);
          // ctx.mainWindow.webContents.send("new-content-available");
        }
      } catch (error) {
        logger.info(`failed to fetch identity: ${id}`);
        logger.info(error);
      }
    }
  };
  ipcMain.on("update-following", async event => {
    const result = await updateFollowing();
    event.sender.send("update-following-complete", result);
  });
  ipcMain.handle("update-following", async () => {
    const result = await updateFollowing();
    return result;
  });

  const followId = async id => {
    logger.info("[Identity] followId()");
    if (!self.following.includes(id)) {
      self.following.push(id);
      await save();
    }
  };
  ipcMain.on("follow", async (event, id) => {
    await followId(id);
  });

  const unfollowId = async id => {
    logger.info("[Identity] unfollowId()");
    if (self.following.includes(id)) {
      const id_index = self.following.indexOf(id);
      if (id_index > -1) {
        self.following.splice(id_index, 1);
      }
      await save();
      // level_db.del(id)
    }
  };
  ipcMain.on("unfollow", async (event, id) => {
    await unfollowId(id);
  });

  const getPostIpfs = async post_cid => {
    logger.info("getPostIpfs");
    await pinCID(post_cid);
    let post_buffer;
    try {
      post_buffer = Buffer.concat(await all(ipfs.cat(`${post_cid}/post.json`)));
    } catch (error) {
      post_buffer = Buffer.concat(await all(ipfs.cat(post_cid)));
    }
    return JSON.parse(post_buffer);
  };

  const getPost = async (identity_object, cid) => {
    logger.info("getPost");
    let post_object;
    if (!identity_object.posts_deep) {
      identity_object.posts_deep = {};
    }
    if (identity_object.posts_deep && identity_object.posts_deep[cid]) {
      logger.info("loading post from DB...");
      post_object = identity_object.posts_deep[cid];
    } else {
      logger.info("loading post from IPFS...");
      post_object = await getPostIpfs(cid);
      identity_object.posts_deep[cid] = post_object;
      await level_db.put(identity_object.id, identity_object);
      // ctx.mainWindow.webContents.send("new-content-available");
    }
    if (!post_object.publisher) {
      post_object.publisher = identity_object.id;
    }
    post_object.postCid = cid;
    post_object.identity = {};
    post_object.identity.av = identity_object.av;
    post_object.identity.dn = identity_object.dn;
    post_object.identity.id = identity_object.id;
    post_object.identity.ts = identity_object.ts;
    return post_object;
  };

  // get post
  ipcMain.on("get-post", async (event, id, postCid) => {
    const identity_object = await getIdentity(id);
    const post_object = await getPost(identity_object, postCid);
    event.sender.send("post", post_object);
  });

  // get posts
  ipcMain.on("get-posts", async (event, id) => {
    const identity_object = await getIdentity(id);
    for await (const postCid of identity_object.posts) {
      const post_object = await getPost(identity_object, postCid);
      event.sender.send("post", post_object);
    }
  });

  // get feed
  ipcMain.on("get-feed", async event => {
    logger.info("get-feed");
    feed = await level_db.get("feed");
    feed.forEach(post_object => {
      event.sender.send("feedItem", post_object);
    });
  });

  // get feed all
  ipcMain.on("get-feed-all", async event => {
    feed = await level_db.get("feed");
    event.sender.send("feedAll", feed);
  });

  // update feed
  const updateFeed = async () => {
    logger.info("updateFeed()");
    feed = await level_db.get("feed");
    for await (const fid of self.following) {
      const identity_object = await getIdentity(fid);
      for await (const postCid of identity_object.posts) {
        const post_object = await getPost(identity_object, postCid);
        if (post_object) {
          if (!feed.some(id => id.ts === post_object.ts)) {
            feed.unshift(post_object);
            // feed.sort((a, b) => (a.ts > b.ts ? -1 : 1));
          }
        }
      }
    }
    feed.sort((a, b) => (a.ts > b.ts ? 1 : -1));
    await level_db.put("feed", feed);
  };
  ipcMain.on("update-feed", async event => {
    const result = await updateFeed();
    event.sender.send("update-feed-complete", result);
  });
  ipcMain.handle("update-feed", async () => {
    const result = await updateFeed();
    return result;
  });

  // get following deep
  ipcMain.on("get-following", async event => {
    for await (const fid of self.following) {
      const identity_object = await getIdentity(fid);
      delete identity_object.posts_deep;
      event.sender.send("followingIdentity", identity_object);
    }
  });

  // add post
  const addPost = async post => {
    logger.info("[Identity] addPost()");
    const { body, files } = post;
    console.log(files);
    console.log(body);
    let filesRoot = "";
    let file_list = [];
    let file_names = [];

    let ts = Math.floor(new Date().getTime());
    if (files.length) {
      for await (const file of files) {
        const file_object = {
          path: file.name,
          content: await fs.readFile(file.path)
        };
        file_names.push(file.name);
        file_list.push(file_object);
      }

      logger.info(file_names);
      logger.info(file_list);
      const add_options = {
        pin: true,
        wrapWithDirectory: true,
        timeout: 10000
      };
      const add_result = await ipfs.add(file_list, add_options);
      filesRoot = add_result.cid.string;
      logger.info("addRet1");
      logger.info(add_result);
    }

    const post_object = {
      body: body,
      dn: self.dn,
      files: file_names,
      filesRoot: filesRoot,
      magnet: "",
      meta: [],
      publisher: ipfs_id.id,
      ts: ts
    };
    logger.info("post_object");
    logger.info(post_object);
    const index_html = await fs.readFile(
      path.join(__statics, "/postStandalone.html")
    );
    const obj = [
      {
        path: "post.json",
        content: JSON.stringify(post_object)
      },
      {
        path: "index.html",
        content: index_html
      }
    ];
    const add_options = {
      // pin: true,
      wrapWithDirectory: true,
      timeout: 10000
    };
    const add_result = await ipfs.add(obj, add_options);
    logger.info("addRet2");
    logger.info(add_result);
    const cid = add_result.cid.string;
    if (typeof cid === "string" && cid.length == 46) {
      self.posts.unshift(cid);
      save();
    }
    // post_object.postCid = cid;
    // post_object.identity = {};
    // post_object.identity.av = self.av;
    // post_object.identity.dn = self.dn;
    // post_object.identity.id = self.id;
    // post_object.identity.ts = self.ts;
    // ctx.mainWindow.webContents.send("feedItem", post_object);
    return add_result;
  };
  ipcMain.on("add-post", async (event, post_object) => {
    console.log(post_object);
    await addPost(post_object);
  });
  ipcMain.handle("add-post", async (event, post_object) => {
    console.log(post_object);
    const add_result = await addPost(post_object);
    return add_result;
  });

  // remove post
  const removePost = async cid => {
    logger.info("[Identity] removePost()");
    const post_index = self.posts.indexOf(cid);
    if (post_index > -1) {
      self.posts.splice(post_index, 1);
    }
    const identity_object = await getIdentity(ipfs_id.id);
    if (identity_object.posts_deep && identity_object.posts_deep[cid]) {
      delete identity_object.posts_deep[cid];
      await level_db.put(ipfs_id.id, identity_object);
    }
    save();
  };
  ipcMain.on("remove-post", async (event, cid) => {
    await removePost(cid);
  });
  ipcMain.handle("remove-post", async (event, cid) => {
    const remove_result = await removePost(cid);
    return remove_result;
  });

  // repost
  const repost = async cid => {
    logger.info("[Identity] repost()");
    if (!self.posts.includes(cid)) {
      self.posts.unshift(cid);
      await save();
    }
  };
  ipcMain.on("repost", async (event, postCid) => {
    await repost(postCid);
    event.sender.send();
  });
  ipcMain.handle("repost", async (event, postCid) => {
    console.log(event);
    const result = await repost(postCid);
    return result;
  });
  //

  await init();
};
