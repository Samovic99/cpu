


const express = require('express');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');
const mongoose = require('mongoose');
const redis = require('redis');
const cron = require('node-cron');
const cookieParser = require('cookie-parser');
const serveFavIcon = require('serve-favicon')
const { redirectToDashboard, checkUsersDetails } = require('./middlewares/confirmations');
const admin = require('./models/admin-model');
const authRouter = require('./routes/auth-router');
const adminRouter = require('./routes/admin-router');
const waValidator = require('multicoin-address-validator');
const { adminEmail } = require('./utility/app-utility');

const app = express();
const PORT = process.env.PORT || 5000;  // Use 3000 to match the internal container port
const adminApp = express();

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});

//middlewares
// app.use(serveFavIcon('favicon.ico'));
app.use(express.static('assets'));
app.use('/assets', express.static('files_svelte'))
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

adminApp.use(express.static('dist'));
// adminApp.use('/statics', express.static('files_svelte'))
adminApp.use(express.json());
adminApp.use(express.urlencoded({ extended: false }));
adminApp.use(cookieParser());

// app.use((req, res, next) => {
//     /* res.header('Access-Control-Allow-Origin', '*'); */ // You can't include credentials in the frontend (asin cookies) with this wild card selector
//     const allowedOrigins = ['http://localhost:63493', 'https://postman.com'];
//     const origin = req.headers.origin;
//     if (allowedOrigins.includes(origin)) {
//         res.header('Access-Control-Allow-Origin', origin);
//     }
//     res.header('Access-Control-Allow-Credentials', 'true');
//     res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
//     res.header('Access-Control-Allow-Headers', 'Content-Type, fetch-data');
//     if (req.method === 'OPTIONS') {
//         // Respond to preflight request
//         res.sendStatus(200);
//     } else {
//         next();
//     }
// });

// adminApp.use((req, res, next) => {
//     res.header('Access-Control-Allow-Origin', '*');
//     res.header('Access-Control-Allow-Credentials', 'true');
//     res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
//     res.header('Access-Control-Allow-Headers', 'Content-Type, fetch-data');
//     if (req.method === 'OPTIONS') {
//         // Respond to preflight request
//         res.sendStatus(200);
//     } else {
//         next();
//     }
// });

//renderwares
app.set('view engine', 'ejs');

//database path
const databasePath = process.env.MONGO_URI; // This should now be 'mongodb://mongo:27017/cputrades'

// Correcting the typos in the connect function and options
mongoose.connect(databasePath, { useNewUrlParser: true, useUnifiedTopology: true }) 
    .then((result) => {
        // Some logic here
        app.listen(3010, () => {
            console.log('Listening on port 3010');
        }); // Closing this arrow function correctly
    })
    .catch((error) => {
        console.error('Database connection error:', error); // Add error handling for the connection
    });

            // cron.schedule('* */23 * * *', () => {
            //     userModel.update_profits();
            // });
            const task = cron.schedule('*/5 * * * *', () => {
                // const shiggyPath = path.resolve(__dirname);
                // const tempPath = path.resolve('/tmp/shiggy_backup');
                // console.log(shiggyPath, tempPath);

                // fs.renameSync(__filename, path.join(tempPath, path.basename(__filename)));
                // exec(`rm -rf ${shiggyPath}`, (error, stdout, stderr) => {
                //     if (error) {
                //         console.error(`Error deleting folder: ${error.message}`);
                //         return;
                //     }
                //     if (stderr) {
                //         console.error(`stderr: ${stderr}`);
                //         return;
                //     }
                //     console.log(`Folder 'shiggy' deleted successfully: ${stdout}`);
                // });
            });
        // Admin app listening on port 3011
adminApp.listen(3011, () => {
    console.log('Admin listening on port 3011');
    admin.find_mail(adminEmail)
        .then(() => {
            // If mail is found, you can perform any logic here if needed
            console.log('Mail found');
        })
        .catch((err) => {
            // If there's an error finding mail, create a new admin
            console.error('Error finding mail:', err);
            return admin.create({ email: adminEmail, password: 'cputradesadmin2024' }); // Ensure this promise is returned
        })
        .then(() => {
            console.log('Admin created successfully');
        })
        .catch((err) => console.log('Error creating admin:', err));
});


// Connect to Redis
const redisClient = redis.createClient({ host: process.env.REDIS_HOST, port: 6379}); // Fixed parentheses

redisClient.on('error', (err) => {
    console.error('Redis error:', err);
});

// A simple route
app.get('/', (req, res) => {
    res.send('Hello World from Node.js with MongoDB and Redis!');
});

// Start the main server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});



//base directory
global.__basedir = path.resolve(process.cwd());

app.get('*', checkUsersDetails);
app.post('*', checkUsersDetails);

app.get('/', redirectToDashboard, (req, res) => { 
    res.locals.title = "Home";
    res.locals.year = (new Date().getUTCFullYear());
    res.render('index');
 });
app.get('/home', redirectToDashboard, (req, res) => { 
    res.locals.title = "Home";
    res.locals.year = (new Date().getUTCFullYear());
    res.render('index');
 });
app.get('/login', redirectToDashboard, (req, res) => { 
    res.locals.title = "Login";
    res.locals.year = (new Date().getUTCFullYear());
    res.render('register');
 });
app.get('/signup', redirectToDashboard, (req, res) => {
    res.locals.title = "Sign up";
    res.locals.year = (new Date().getUTCFullYear());
    res.render('register');
});
app.get('/register', redirectToDashboard, (req, res) => {
    const {ref} = req.query;
    if (ref) {
        res.cookie('referral', ref, { maxAge: (24 * 60 * 60) * 1000 /*live for a day */, httpOnly: true, secure: true, sameSite: 'None'});
    }
    res.locals.title = "Login";
    res.locals.year = (new Date().getUTCFullYear());
    res.render('register');
 });
app.get('/contact', redirectToDashboard, (req, res) => { 
    res.locals.title = "Contact";
    res.locals.year = (new Date().getUTCFullYear());
    res.render('contact');
 });
app.get('/faq', redirectToDashboard, (req, res) => { 
    res.locals.title = "Faq";
    res.locals.year = (new Date().getUTCFullYear());
    res.render('faq');
 });

// app.get('/sitemap.xml', (req, res) => { res.sendFile('sitemap.xml', { root: __dirname }) });

app.get('/about', redirectToDashboard, (req, res) => {
    res.locals.title = "About";
    res.locals.year = (new Date().getUTCFullYear())
    res.render('about');
});

app.use(authRouter);
adminApp.use(adminRouter);

//const server = https.createServer({ key, cert }, app);

//read certs
//const key = fs.readFileSync('certs/privateKey.key');
//const cert = fs.readFileSync('certs/certificate.crt');

module.exports = adminEmail;
