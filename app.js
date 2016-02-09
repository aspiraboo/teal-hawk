"use strict";
//var extend = require('util')._extend;
var extend = require('lodash/fp/extend');

var mongodb = require('mongodb').MongoClient;
var tweetsDB = 'mongodb://127.0.0.1:27017/tweets'
var connectMongo = require('connect-mongo');

var config = require('./config.js');
var Twitter = require('twit');
var express = require('express');
var cookieParser = require('cookie-parser');
var session = require('express-session');
var ejs = require('ejs');

var passport = require('passport');
var passportSocketIo = require("passport.socketio");
var http = require("http");
var socketio = require('socket.io');

var app = express();
var server = http.createServer(app);
var io = socketio.listen(server);
var MongoStore = connectMongo(session);

// Passport and Passport.SocketIO setup
var sessionStore = new MongoStore({url: tweetsDB});
var Strategy = require('passport-twitter').Strategy;
passport.use(new Strategy({
    consumerKey: config.twitter.consumer_key,
    consumerSecret: config.twitter.consumer_secret,
    callbackURL: config.twitter.callbackURL
  },
  function(token, tokenSecret, profile, cb) {
    if(profile.id=='42383066') {;
      return cb(null, {user_id: profile.id, user_name: profile.username, user_image: profile.photos[0].value});
    } else{
      return cb(null, false);
    }
  }
));

passport.serializeUser(function(user, cb) {
  cb(null, user);
});

passport.deserializeUser(function(obj, cb) {
  cb(null, obj);
});

io.use(passportSocketIo.authorize({
  cookieParser: cookieParser,
  key:          config.passport.key,
  secret:       config.passport.secret,
  store:        sessionStore,
  success:      onAuthorizeSuccess,
  fail:         onAuthorizeFail
}));

function onAuthorizeSuccess(data, accept){
  accept();
}

function onAuthorizeFail(data, message, error, accept){
  accept(new Error(message));
}

// Express setup
app.set('views', __dirname + '/public/ejs_views');
app.set('view engine', 'ejs');
app.use(session({key: config.passport.key, secret: config.passport.secret, store: sessionStore, saveUninitialized: false, resave: false }));
app.use(cookieParser());
app.use(passport.initialize());
app.use(passport.session());

// Express routes
app.get('/login/twitter',
  passport.authenticate('twitter'));

app.get('/login/twitter/callback',
  passport.authenticate('twitter', { failureRedirect: '/login/#/baduser'}),
  function(req, res) {
      res.redirect('/');
  });

app.get('/login',function(req,res){
  if (req.user) {
    res.redirect('/');
  } else {
    res.sendFile(__dirname + '/public/login.html');
  }
});

app.get('/logout', function(req, res){
  req.logout();
  res.redirect('/');
});

app.get('/menu-bar', function(req, res) {
  res.render('menu-bar', { user: req.user });
})

app.get('*', 
  require('connect-ensure-login').ensureLoggedIn('/login'),
  function(req, res){
    res.sendFile(__dirname + '/public' + req.url);
});

// Connect to mongodb, Twitter stream, and fire listen for socketio request
mongodb.connect(tweetsDB, function (err, db) {
  if (err) {
    console.error('Can\'t connect to mongodb. Exiting. ');
    process.exit(1);
  } else {
    console.log('Connected to mongo');

    io.sockets.on('connection', function (socket) {
      // Upon connection to single client for first time await listen events
      console.log(socket.id + ' connected');
      
      socket.on('disconnect', function() {
        console.log(socket.id + ' disconnected');
      }); 
      
      // This tells us the new client needs initial Tweets
      socket.on('initRequest', function(initRequest) {
        // #TODO# - validate initRequest
        console.log(Date() + ': initRequest from ' + socket.id + ' for ' + initRequest.tweetColumn);
        
        // Get column's search parameters from mongodb
        db.collection('columns').find({'id': initRequest.tweetColumn},{'parameters':1,"_id":0}).limit(1).toArray(function(err, column) {
          // Request 'limit' Tweets from mongodb
          // #TODO# - make sure we got valid data to column[0]
          var searchQuery = extend(JSON.parse(column[0].parameters), {'retweeted_status':{'$exists':false}});
          db.collection('tweets').find(searchQuery).sort([['id_str', -1]]).limit(initRequest.tweetCount).toArray(function (err, tweet) {
            if (tweet !== null) {
              // emit Tweets back to client/column that made request
              socket.emit('bottomTweet', [initRequest.tweetColumn, tweet]);
            }
          }); 
        });
        
        console.log(Date() + ': initRequest to ' + socket.id + ' for ' + initRequest.tweetColumn);
      }); // End of initRequest event

      // This event is recieved from a client who lost connection and is reconnecting
      socket.on('updateRequest', function (updateRequest) {
        // #TODO# - validate updateRequest
        console.log(Date() + ': ' + socket.id + ' reconnected.');
        // Get column's search parameters from mongodb
        db.collection('columns').find({'id': updateRequest.tweetColumn},{'parameters':1,"_id":0}).limit(1).toArray(function(err, column) {
          var searchQuery = extend({id_str: {$gt: updateRequest.lastTweet}}, extend(JSON.parse(column[0].parameters), {'retweeted_status':{'$exists':false}}));
          db.collection('tweets').find(searchQuery).toArray(function (err, tweet) {
            if ((tweet !== null) && (tweet.length>0)) {
              socket.emit('topTweet', [updateRequest.tweetColumn, tweet]);
              console.log(Date() + ': ' + tweet.length + ' tweets sent to ' + socket.id + ' for column ' + updateRequest.tweetColumn);
            } else {
              console.log('No new tweets since ' + updateRequest.lastTweet + ' to send for column ' + updateRequest.tweetColumn);
            }
          });
        });
      }); // End of updateRequest event
      
      // This event is recieved when client goes to bottom of view and needs more tweets
      socket.on('NextTweets', function (nextTweets) {
        // #TODO# - validate nextTweets
        console.log(Date() + ': nextTweets from ' + socket.id + ' for ' + nextTweets.tweetColumn + ' after ' + nextTweets.lastTweet);
        var query = {id: nextTweets.tweetColumn};
        var restrict = {parameters:1,_id:0};
        db.collection('columns').find(query,restrict).limit(1).toArray(function(err, column) {
          // Request 'limit' Tweets from mongodb
          var query = extend({id_str: {$lt: nextTweets.lastTweet}}, extend(JSON.parse(column[0].parameters), {'retweeted_status':{'$exists':false}}));
          db.collection('tweets').find(query).sort([['id_str', -1]]).limit(nextTweets.tweetCount).toArray(function (err, tweet) {
            if (tweet !== null) {
              socket.emit('bottomTweet', [nextTweets.tweetColumn, tweet]);
            } 
          }); 
        });
      });
    }); // End of NextTweets event
    
    var twit = new Twitter({
      consumer_key: config.twitter.consumer_key,
      consumer_secret: config.twitter.consumer_secret,
      access_token: config.twitter.access_token,
      access_token_secret: config.twitter.access_token_secret
    });

    // Open new Twitter stream with Twat
    var stream = twit.stream('statuses/filter', config.twitter.filter);
    stream.on('connected', function() {
      console.log(Date() + ': connected to Twitter');
    });
    
    stream.on('tweet', function (tweet) {
        console.log(tweet.created_at + ' new tweet ' + tweet.id_str);
        newTweet(tweet);
    });
    
    // Not sure of value add here, but take it anyway. 
    stream.on('quoted_tweet', function (tweet) {
      console.log(tweet.created_at + ' quoted tweet ' + tweet.id_str);
      newTweet(tweet);
    });
    
    function newTweet(tweet) {
      tweet.created_at = new Date(tweet.created_at);
      if (tweet.quote_status) {
        tweet.quote_status.created_at = new Date(tweet.quote_satus.created_at);
      }
      var tweetOut = [tweet];
      if(!tweet.retweeted_status) {
        io.sockets.emit('topTweet', ['*', tweetOut]);
      }
      db.collection('tweets').insert(tweet, function (err, records) {
        if (err) {
          console.log('Database error: ' + err)
        } else {
          console.log('tweet id ' + tweet.id_str + ' inserted to mongodb');
        }
      });
    }
      
    stream.on('delete', function (deleteData) {
      db.collection('tweets').deleteOne({id_str:deleteData.delete.status.id_str}, function(err, records){
        if (err) throw err; 
        console.log(Date() + ': tweet ' + deleteData.delete.status.id_str + ' deleted');
        io.sockets.emit('deleteTweet', deleteData.delete.status.id_str);
      });
    });
    
    // bit of debugging here, needs to be handled rather than just spat out
    stream.on('limit', function (limitMessage) {
      console.log(Date() + ': limit - ');
      console.error(limitMessage);
      console.log('end of limit');
    });

    stream.on('reconnect', function (request, response, connectInterval) {
      console.log(Date() + ': reconnect: ' + connectInterval);
    })

    stream.on('parse-error', function(error) {
      console.log(Date() + ': parse-error - ');
      console.error(error);
      console.log('end of parse-error');
    });

    stream.on('error', function(error) {
      console.log(Date() + ': error - ');
      console.error(error);
      console.log('end of error');
    });

    stream.on('warning', function(msg) {
      console.log(Date() + ': warning - ');
      console.error(msg);
      console.log('end of warning');
    });
    
  }
});

server.listen(3000);