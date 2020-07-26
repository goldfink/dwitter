const { remote } = require("electron");
const APP_DATA_PATH = remote.app.getPath("appData");
const path = require("path");
const fs = require("fs-extra");
const all = require("it-all");
const IpfsHttpClient = require("ipfs-http-client");
const levelup = require("levelup");
const leveldown = require("leveldown");
const encode = require("encoding-down");

class Identity {
  serialize() {
    return {
      av: this.av,
      aux: this.aux,
      dn: this.dn,
      following: this.following,
      id: this.id,
      meta: this.meta,
      posts: this.posts,
      ts: Math.floor(new Date().getTime())
    };
  }

  constructor(id) {
    console.log(`Identity.constructor()`);
    this.av = "";
    this.aux = {};
    this.dn = "";
    this.following = [id];
    this.id = id;
    this.meta = [];
    this.posts = [];
    this.ts = Math.floor(new Date().getTime());

    // private
    this.ipfs = null;
    this.leveldb = null;
    this.feed = [];
    this.following_deep = [];
    this.meta_deep = [];
    this.posts_deep = [];
    this.init();
  }

  dbContainsKey(db, key) {
    return new Promise(resolve => {
      db.get(key, function(err) {
        if (err) resolve(false);
        resolve(true);
      });
    });
  }

  async init() {
    console.log("init");
    this.ipfs = IpfsHttpClient({
      host: "localhost",
      port: "5001",
      protocol: "http"
    });
    const { id } = await this.ipfs.id();
    console.log(id);
    this.id = id;

    // ensure paths and directories...
    this.appDataPath = path.join(APP_DATA_PATH, "follow");
    if (!fs.existsSync(this.appDataPath)) {
      fs.mkdirSync(this.appDataPath);
    }
    this.followStoragePath = path.join(this.appDataPath, "Follow Storage");
    if (!fs.existsSync(this.followStoragePath)) {
      fs.mkdirSync(this.followStoragePath);
    }
    this.identityPath = path.join(this.followStoragePath, this.id);

    // ensure db
    this.leveldb = levelup(
      encode(leveldown(this.followStoragePath), {
        valueEncoding: "json"
      })
    );
    if (!(await this.dbContainsKey(this.leveldb, this.id))) {
      await this.save();
    } else {
      await this.load();
    }
    await this.getFeed();
    await this.publish();

    const _this = this;
    setInterval(async function() {
      console.log("refreshing feed...");
      await _this.updateFollowing();
      await _this.getFeed();
    }, 1 * 60 * 1000);
    setInterval(async function() {
      console.log("auto-publish...");
      await _this.publish();
    }, 60 * 60 * 1000);
  }

  async load() {
    console.log("Identity.read()");
    const idObj = await this.leveldb.get(this.id);
    for (const prop in idObj) this[prop] = idObj[prop];
  }

  async save() {
    console.log("Identity.save()");
    await this.leveldb.put(this.id, this.serialize());
    await this.publish();
  }

  async publish() {
    console.log("Identity.publish()");
    const idObj = await this.serialize();
    const obj = {
      path: "identity.json",
      content: JSON.stringify(idObj)
    };
    const addOptions = {
      pin: true,
      wrapWithDirectory: true,
      timeout: 10000
    };
    const pub = await this.ipfs.add(obj, addOptions);
    return await this.ipfs.name.publish(pub.cid.string, { lifetime: "8760h" });
  }

  async pinCID(cid) {
    console.log(`Identity.pinCID(${cid})`);
    const pinResult = await this.ipfs.pin.add(cid);
    // console.log("pinResult");
    // console.log(pinResult);
    return pinResult;
  }

  async getIdentityIpfs(id) {
    console.log(`Identity.getIdentityIpfs(${id})`);
    const identityFileCID = await all(this.ipfs.name.resolve(id));
    // console.log("identityFileCID");
    // console.log(identityFileCID);
    const cid = `${identityFileCID[0]}/identity.json`;
    // await this.pinCID(cid);
    const identityJson = Buffer.concat(await all(this.ipfs.cat(cid)));
    return JSON.parse(identityJson);
  }

  async getIdentity(id) {
    console.log(`getIdentity(${id})`);
    let idObj;
    if (await this.dbContainsKey(this.leveldb, id)) {
      console.log("loading identity from DB...");
      idObj = await this.leveldb.get(id);
    } else {
      console.log("loading identity from IPFS...");
      idObj = await this.getIdentityIpfs(id);
      if (id !== this.id) {
        await this.leveldb.put(id, idObj);
      }
    }
    console.log(idObj);
    return idObj;
  }

  async updateFollowing() {
    console.log("updateFollowing()");
    const following_deep = [];
    for await (const fid of this.following) {
      if (fid !== this.id) {
        const idObj = await this.getIdentityIpfs(fid);
        following_deep.push(idObj);
        await this.leveldb.put(fid, idObj);
      }
    }
    this.following_deep = following_deep;
  }

  async addToFollowing(id) {
    console.log("Identity.addToFollowing()");
    if (!this.following.includes(id)) {
      this.following.push(id);
      await this.leveldb.put(this.id, this.serialize());
    }
  }

  async getPostIpfs(cid) {
    console.log("getPostIpfs");
    // await this.pinCID(cid);
    let post;
    try {
      post = Buffer.concat(await all(this.ipfs.cat(`${cid}/post.json`)));
    } catch (error) {
      post = Buffer.concat(await all(this.ipfs.cat(cid)));
    }
    return JSON.parse(post);
  }

  async getPost(id, cid) {
    console.log("getPost");
    let postObj;
    const idObj = await this.getIdentity(id);
    if (!idObj.posts_deep) {
      idObj.posts_deep = {};
    }
    if (idObj.posts_deep && idObj.posts_deep[cid]) {
      console.log("loading post from DB...");
      postObj = idObj.posts_deep[cid];
    } else {
      console.log("loading post from IPFS...");
      postObj = await this.getPostIpfs(cid);
      idObj.posts_deep[cid] = postObj;
      await this.leveldb.put(id, idObj);
    }
    return postObj;
  }

  async getFeed() {
    console.log("getFeed()");
    for await (const fid of this.following) {
      const idObj = await this.getIdentity(fid);
      for await (const postCid of idObj.posts) {
        const postObj = await this.getPost(fid, postCid);
        // console.log(fid);
        // console.log("postObj");
        // console.log(postObj);
        postObj.dt = new Date(Number(postObj.ts));
        postObj.postCid = postCid;
        postObj.identity = idObj;
        if (!this.feed.some(id => id.ts === postObj.ts)) {
          console.log("pushing...");
          this.feed.push(postObj);
          this.feed.sort((a, b) => (a.ts > b.ts ? -1 : 1));
        }
      }
    }
  }

  async getPostList() {
    console.log("Identity.getPostList()");
    const feed = [];
    for await (const postCid of this.posts) {
      const postObj = await this.getPostIpfs(postCid);
      postObj.dn = this.dn;
      postObj.publisher = this.id;
      postObj.dt = new Date(Number(postObj.ts));
      feed.push(postObj);
    }
    feed.sort((a, b) => (a.ts > b.ts ? -1 : 1));

    return feed;
  }

  async addPost(body, files) {
    console.log("Identity.addPost()");
    console.log(files);
    console.log(body);
    let filesRoot = "";
    let addedFiles = [];
    let fileNames = [];

    let ts = Math.floor(new Date().getTime());
    if (files.length) {
      for await (const file of files) {
        const fileObj = {
          path: file.name,
          content: await fs.readFile(file.path)
        };
        fileNames.push(file.name);
        addedFiles.push(fileObj);
      }

      console.log(fileNames);
      console.log(addedFiles);
      const addOptions = {
        // pin: true,
        wrapWithDirectory: true,
        timeout: 10000
      };
      const addRet = await this.ipfs.add(addedFiles, addOptions);
      filesRoot = addRet.cid.string;
      console.log("addRet");
      console.log(addRet);
    }

    const postObj = {
      body: body,
      dn: this.dn,
      files: fileNames,
      filesRoot: filesRoot,
      magnet: "",
      meta: [],
      publisher: this.id,
      ts: ts
    };
    console.log(postObj);
    const indexHTML = await fs.readFile("src/modules/postStandalone.html");
    const obj = [
      {
        path: "post.json",
        content: JSON.stringify(postObj)
      },
      {
        path: "index.html",
        content: indexHTML
      }
    ];
    const addOptions = {
      // pin: true,
      wrapWithDirectory: true,
      timeout: 10000
    };
    const addRet = await this.ipfs.add(obj, addOptions);
    console.log("addRet");
    console.log(addRet);
    const cid = addRet.cid.string;
    if (typeof cid === "string" && cid.length == 46) {
      this.posts.unshift(cid);
      this.save();
      this.getFeed();
    }
  }
}

module.exports.Identity = Identity;
