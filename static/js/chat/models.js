/* global app, Backbone, _, tnetbin */
/**
 * ChatApp models and collections.
 */
(function(app, Backbone, tnetbin) {
  "use strict";

  /**
   * FileTransfer model.
   *
   * Attributes:
   * - {Integer} progress
   *
   * Fired when a new chunk is available.
   * @event chunk
   * @param {String} id the id of the file transfer
   * @param {ArrayBuffer} chunk
   *
   * Fired when the transfer is complete.
   * @event complete
   * @param {File|Blob} file the file transfered
   *
   * Example:
   *
   * // Sender side
   * var transfer =
   *   new app.models.FileTransfer({file: file}, {chunkSize: 512 * 1024});
   * transfer.on("chunk", function(id, chunk) {
   *   sendChunk(id, chunk);
   * });
   * transfer.start();
   *
   * // Receiver side
   * var transfer =
   *   new app.models.FileTransfer({filename: filename, size: size});
   * transfer.on("complete", function(blob) {
   *   window.URL.createObjectURL(blob);
   * });
   * transfer.append(chunk);
   * transfer.append(chunk);
   * transfer.append(chunk);
   * ...
   *
   */
  app.models.FileTransfer = Backbone.Model.extend({

    /**
     * Filetransfer model constructor.
     * @param  {Object}  attributes  Model attributes
     * @param  {Object}  options     Model options
     *
     * Attribues:
     *
     * When initiating a file tranfer
     *
     * - {File} file The file to transfer
     *
     * When receiving a file transfer
     *
     * - {String} filename The name of the received file
     * - {Integer} size The size of the received file
     *
     * Options:
     *
     * When initiating a file tranfer
     *
     * - {Integer} chunkSize The size of the chunks
     *
     */
    initialize: function(attributes, options) {
      this.options = options;
      this.id = this.set("id", _.uniqueId()).id;

      if (attributes.file) {
        this.file          = attributes.file;
        this.filename      = attributes.file.name;
        this.size          = attributes.file.size;
        this.reader        = new FileReader();
        this.reader.onload = this._onChunk.bind(this);
      } else {
        this.size          = attributes.size;
        this.filename      = attributes.filename;
        this.chunks        = [];
      }

      this.seek = 0;
      this.on("chunk", this._onProgress, this);
    },

    /**
     * Turns a FileTransfer object into a JSON ready object.
     *
     * @return {Object} the serializable object
     *
     * Return value:
     * - {String} filename The name of the file
     * - {Integer} progress The progress of the file transfer
     */
    toJSON: function() {
      var progress = this.get("progress");
      var json = {
        filename: _.escape(this.filename),
        progress: progress || 0
      };

      if (progress === 100)
        json.url = window.URL.createObjectURL(this.blob || this.file);

      return json;
    },

    /**
     * Start the file transfer.
     *
     * It actually trigger the file transfer to emit chunks one after
     * the other until the end of the file is reached.
     */
    start: function() {
      this._readChunk();
    },

    /**
     * Append a chunk to the current file transfer.
     *
     * Accumulates the data until the transfer is complete.
     * Raise an error if we append more data than expected.
     *
     * @param {ArrayBuffer} chunk the chunk to append
     */
    append: function(chunk) {
      this.chunks.push(chunk);
      this.seek += chunk.byteLength;

      if (this.seek === this.size) {
        this.blob = new Blob(this.chunks);
        this.chunks = [];
        this.trigger("complete", this.blob);
      }
      this.trigger("chunk", this.id, chunk);

      if (this.seek > this.size)
        throw new Error("Received more data than expected: " +
                        this.seek + " instead of " + this.size);
    },

    _onChunk: function(event) {
      var data = event.target.result;

      this.seek += data.byteLength;
      this.trigger("chunk", this.id, data);

      if (this.seek < this.file.size)
        this._readChunk();
      else
        this.trigger("complete", this.file);
    },

    _onProgress: function() {
      var progress = Math.floor(this.seek * 100 / this.size);
      this.set("progress", progress);
    },

    _readChunk: function() {
      var blob = this.file.slice(this.seek, this.seek + this.options.chunkSize);
      this.reader.readAsArrayBuffer(blob);
    }
  });

  app.models.TextChatEntry = Backbone.Model.extend({
    defaults: {nick: undefined,
               message: undefined,
               date: new Date().getTime()}
  });

  app.models.TextChat = Backbone.Collection.extend({
    model: app.models.TextChatEntry,

    media: undefined,
    peer: undefined,

    initialize: function(attributes, options) {
      if (!options || !options.media)
        throw new Error('TextChat model needs a `media` option');
      if (!options || !options.peer)
        throw new Error('TextChat model needs a `peer` option');

      this.media = options && options.media;
      this.peer = options && options.peer;

      this.media.on('dc:message-in', this._onDcMessageIn.bind(this));
      this.on('add', this._onTextChatEntryCreated.bind(this));
      this.on('add', this._onFileTransferCreated.bind(this));

      this.media.on('dc:close', function() {
        this.terminate().reset();
      });
    },

    initiate: function(constraints) {
      this.media.once("offer-ready", function(offer) {
        this.trigger("send-offer", {
          peer: this.peer.get("nick"),
          offer: offer,
          textChat: true
        });
      }, this);

      this.media.initiate(constraints);
    },

    answer: function(offer) {
      this.media.once("answer-ready", function(answer) {
        this.trigger("send-answer", {
          peer: this.peer.get("nick"),
          answer: answer,
          textChat: true
        });
      }, this);

      this.media.answer(offer);
    },

    establish: function(answer) {
      this.media.establish(answer);
    },

    /**
     * Adds a new entry to the collection and sends it over data channel.
     * Schedules sending after the connection is established.
     * @param  {Object} entry
     */
    send: function(entry) {
      if (this.media.state.current === "ongoing")
        return this.media.send(entry);

      this.media.once("dc:ready", function() {
        this.send(entry);
      });

      if (this.media.state.current !== "pending")
        this.initiate({video: false, audio: false});
    },

    _onDcMessageIn: function(event) {
      var entry;

      if (event.type === "chat:message")
        entry = new app.models.TextChatEntry(event.message);
      else if (event.type === "file:new")
        entry = new app.models.FileTransfer(event.message);
      else if (event.type === "file:chunk") {
        var chunk = tnetbin.toArrayBuffer(event.message.chunk).buffer;
        var transfer = this.findWhere({id: event.message.id});
        transfer.append(chunk);
      }

      this.add(entry);
    },

    _onTextChatEntryCreated: function(entry) {
      // Send the message if we are the sender.
      // I we are not, the message comes from a contact and we do not
      // want to send it back.
      if (entry instanceof app.models.TextChatEntry &&
          entry.get('nick') === app.data.user.get("nick"))
        this.send({type: "chat:message", message: entry.toJSON()});
    },

    _onFileTransferCreated: function(entry) {
      // Check if we are the file sender. If we are not, the file
      // transfer has been initiated by the other party.
      if (!(entry instanceof app.models.FileTransfer && entry.file))
        return;

      var onFileChunk = this._onFileChunk.bind(this);
      this.send({type: "file:new", message: {
        id: entry.id,
        filename: entry.file.name,
        size: entry.file.size
      }});

      entry.on("chunk", onFileChunk);
      entry.on("complete", entry.off.bind(this, "chunk", onFileChunk));

      entry.start();
    },

    _onFileChunk: function(id, chunk) {
      this.send({type: "file:chunk", message: {id: id, chunk: chunk}});
    }
  });
})(app, Backbone, tnetbin);

