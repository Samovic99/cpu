const userModel = require('../models/users-model');
const {user_verification_status, isStringEmptyOrWhitespace} = require('../utility/app-utility');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const otp = require('otp-generator');
const waValidator = require('multicoin-address-validator');
const {createClient} = require("redis");
const CC = require('currency-converter-lt');
const { sendContactResponse, sendWithdraw, sendOtp, sendResetToken, notifyAdmin, sendDeposit, sendPlanPurchase } = require('./mail-controller');

const redisClient = createClient({
url:'redis://redis:6379'
});
redisClient.on('error', err => console.log('Redis Client Error ', err));
redisClient.connect();

let age = (5 * 30) * 24 * 60 * 60;
const secret = "thisSite is meant for SHIGGY and CpUTrades";
const acceptablePaymentMethods = ["bitcoin", "ethereum", "usdt_trx", "usdt_eth"];


const createToken = (id) => {
    return jwt.sign({ id }, secret, { expiresIn: age });
}

const createResetToken = (user) => {
    const id = user._id;
    return jwt.sign({ id }, secret + user.password, { expiresIn: (60 * 15) });
}

const createConfirmationToken = async(user, description, amount, date, admin) => {
    let status = 'pending';

    amount = Number.parseInt(amount);

    let data = { description, status, amount, date };
    user.history.unshift(data);
    await user.save();

    let savedData = user.history[0];
    admin.pending.unshift(
        {description: savedData.description, transaction_id: savedData._id, amount: savedData.amount, date: savedData.date, user_id: user._id}
    );
    admin.save();

    return jwt.sign({ status, amount }, secret + status, { expiresIn: (60 * 60 * 24 * 7) });
}

const showError = (err) => {
    console.log(err.message, err.code);

    let errors = { status: false, email: err.message, password: "", firstname: "", lastname: "", dob: "", mobile: "", country: "", state: "", city: "", message: err.message }

    if (err.code === 11000) {
        errors.email = "email has already been used";
        return errors;
    }

    if (err.message.includes('Incorrect email')) {
        errors.email = err.message;
        return errors;
    } else if (err.message.includes('Incorrect password')) {
        errors.password = err.message;
        return errors;
    }

    if (err.message.includes("Email does not exist")) {
        errors.email = err.message;
        return errors;
    }

    if (err.message.includes('user validation failed')) {
        Object.values(err.errors).forEach(({ properties }) => {
            errors[properties.path] = properties.message;
        });
    }

    return errors;
};

const shouldRenderDashboardInstead = (req) => {
    const fetchData = req.headers['fetch-data'];
    return (fetchData === undefined ? true : (fetchData === 'false'));
}

const isPaymentMethodAcceptable = (value) => {
    return acceptablePaymentMethods.includes(value);
}

const renderDashboard = (res) => {
    res.sendFile('html/dashboard/index.html', { root: __basedir })
}

module.exports.get_dashboard = (req, res) => {
    if (shouldRenderDashboardInstead(req)) {
        renderDashboard(res);
    } else {
        const user = res.locals.data;
        const response = {
            status: true,
            message: "",
            data: {
                firstname: user.firstname,
                lastname: user.lastname,
                picture: user.picture,
                balance: user.account.balance,
                earnings: user.account.earnings,
                bonus: user.account.bonus,
                plans: user.account.active_plans,
                referals: user.account.ref_bonus,
                transactions: (user.history || []).slice(0, 3)
            }
        }
        res.status(200).json(response)
    }
};

module.exports.get_basic_details = (req, res) => {
    const user = res.locals.data;
    const response = {
        status: true,
        message: "",
        data: {
            email: user.email,
            firstname: user.firstname,
            lastname: user.lastname,
            picture: user.picture,
            date: (new Date()).toISOString(),
            language: (user.settings.language || 'en'),
            currency: (user.settings.currency || 'usd'),
            ref_code: (user.ref_code || 'AA000'),
            paymentMethods: acceptablePaymentMethods
        }
    }
    res.status(200).json(response)
};

module.exports.get_profile = (req, res) => {
    if (shouldRenderDashboardInstead(req)) {
        renderDashboard(res);
    } else {
        const user = res.locals.data;
        const response = {
            status: true,
            message: "",
            data: {
                firstname: user.firstname,
                lastname: user.lastname,
                email: user.email,
                picture: user.picture,
                mobile: user.mobile,
                address: user.address,
                state: user.state,
                country: user.country
            }
        }
        res.status(200).json(response)
    }
};

module.exports.get_history = async (req, res) => {
    if (shouldRenderDashboardInstead(req)) {
        renderDashboard(res);
    } else {
        const user = res.locals.data;
        let {limit, page} = req.query;
        limit = Number.parseInt((limit || 10));
        page = ((page || 0) == 0 ? 1 : Number.parseInt(page));

        const result = await userModel.aggregate([
            { $match: { _id: user._id } }, // Match the user by ID
            {
              $project: {
                transactions: { $slice: ['$history', (page - 1) * limit, limit] },
                totalTransactions: { $size: '$history' } // Include the total count of posts
              }
            }
        ]);

        const response = {
            status: true,
            message: "",
            totalTransactions: result[0].totalTransactions,
            data: {
                results: result[0].transactions
            }
        }
        res.status(200).json(response)
    }
};

module.exports.get_deposit = (req, res) => {
    if (shouldRenderDashboardInstead(req)) {
        renderDashboard(res);
    } else {
        let { method } = req.params;
        let admin = res.locals.admin;

        if (isPaymentMethodAcceptable(method)) {
            const response = {
                status: true,
                message: "",
                data: {
                    "address": admin.accounts[method]
                }
            }
            res.status(200).json(response)
        } else {
            const response = {
                status: false,
                message: "Payment method unrecognized",
                data: {}
            }
            res.status(422).json(response)
        }
    }
};

module.exports.post_deposit = async(req, res) => {
    try {
        const file = req.file;
        const { method, amount } = req.body;
        const { _id, firstname, email } = res.locals.data;
        const admin = res.locals.admin;

        if (isPaymentMethodAcceptable(method)) {
            let date = new Date().toISOString();
            const token = await createConfirmationToken(
                res.locals.data, 
                `${method} deposit to ${admin.accounts[method]}`, 
                amount, 
                date,
                res.locals.admin
            );

            let report = await sendDeposit(email, firstname, amount, [{filename: file.filename, path: file.path}], method);

            // let report = await preConfirmationMessage(_id, token, date, file.path, file.filename, firstname, lastname, email, country);

            const response = {
                status: true,
                message: "Deposit successful. Please await confirmation",
                data: {}
            }
            res.status(200).json(response)
        } else {
            const response = {
                status: false,
                message: "Payment method unrecognized",
                data: {}
            }
            res.status(422).json(response)
        }
    } catch (error) {
        res.status(400).json({status: false, message: "Unknown error occured", data: {}});
        console.log(error);
    }
};

module.exports.post_profile_picture = async(req, res) => {
    const file = req.file;
    const user = res.locals.data;

    try {
        let picturePath = user.picture;
        if (!picturePath.includes("default.png")) {
            fs.rmSync(path.join(__basedir, "assets", picturePath), {
                force: true,
            });
        }

        user.picture = `/img/pictures/${file.filename}`;
        await user.save();
        res.status(201).json(
            {
                status: true,
                message: "Profile picture updated successfully",
                data: {picture: user.picture}
            }
        )
        // res.redirect(req.originalUrl)
        // res.redirect("/profile")
    } catch (error) {
        res.status(400).json({status: false, message: "Unable to update picture", data: {}});
        console.log(error);
    }
}

module.exports.post_verification = async(req, res) => {
    try {
        let objectFile = [];
        let files = req.files;
        let data = res.locals.data;
        console.log(data);
        files.forEach((item) => {objectFile.push({filename: item.filename, path: item.path})});
        await notifyAdmin(data._id, objectFile, `${data.firstname} ${data.lastname}`, data.email, data.address, data.state, data.country );
        const updatedUser = await userModel.findByIdAndUpdate(
            data._id,
            { $set: { verification: objectFile, status:  user_verification_status.verifying} },
            { new: true },
            // (err, updatedUser) => {
            //     if (err) {
            //         console.error('Error updating user:', err);
            //     } else {
            //         console.log('Updated user:', updatedUser);
            //     }
            // }
        );
        console.log(updatedUser);
        if (!updatedUser) {
            throw Error("Can't update user");
        }
        renderDashboard(res);
    } catch (error) {
        console.log(error);
        res.status(400).send(error.message);
    }
}

module.exports.get_withdrawal = (req, res) => {
    if (shouldRenderDashboardInstead(req)) {
        renderDashboard(res);
    } else {
        const user = res.locals.data;
        const response = {
            status: true,
            message: "",
            data: {
                balance: user.account.balance,
                methods: acceptablePaymentMethods
            }
        }
        res.status(200).json(response)
    }
};

module.exports.post_withdrawal = async(req, res) => {
    let response = { status: false, message: "", data: {}};

    try {
        const user = res.locals.data;
        const admin = res.locals.admin;
        const { address, amount, method } = req.body;

        const description = `${method} withdrawal to ${address}`;
        const status = 'pending';
        const date = new Date().toISOString();

        if (
            (method === "bitcoin" && !waValidator.validate(address, 'btc')) || (method === "ethereum" && !waValidator.validate(address, 'eth')) || 
            (method === "usdt-eth" && !waValidator.validate(address, 'usdt')) ||
            (method === "usdt-trc" && !waValidator.validate(address, 'usdt'))
        ) {
            response.message = `Please provide a valid ${method} address`;
            res.status(422).json(response);
            return;
        } else if(!acceptablePaymentMethods.includes(method)) {
            response.message = "Payment method unrecognized";
            res.status(422).json(response);
            return;
        } else if (amount > user.account.balance) {
            response.message = "Illegal Withdrawal. Cannot withdraw more than your balance.";
            res.status(422).json(response);
            return;
        } else if (amount <= 0) {
            response.message = "Illegal Withdrawal. Withdrawal amount must be greater than 0.";
            res.status(422).json(response);
            return;
        }

        const { firstname, email } = user;

        let data = { description, status, amount, date };
        user.history.unshift(data);
        await user.save();

        let savedData = user.history[0];
        admin.pending.unshift(
            {description: savedData.description, transaction_id: savedData._id, amount: savedData.amount, date: savedData.date, user_id: user._id}
        );
        admin.save();

        sendWithdraw(email, firstname, address);

        response.status = true;
        response.message = "Withdrawal request successful. Wait for sometime for confirmation"
        res.status(201).json(response);
    } catch (error) {
        console.log(error);
        response.message = "Withdrawal request failed with unknown error. Please retry after sometime";
        res.status(400).json(response);
    }
}

module.exports.post_signup = async(req, res) => {
    const referrer = req.cookies.referral || null;
    const ref_code = otp.generate(7, { digits: true, lowerCaseAlphabets: true, upperCaseAlphabets: true, specialChars: true })
    const { email, password, firstname, lastname, /* dob, */ mobile, country, state, address } = req.body;
    try {
        const user = await userModel.create({ email, password, firstname, lastname, /* dob, gender, */ mobile, country, state, address, ref_code, referrer });
        const token = createToken(user._id);

        res.cookie('token', token, { maxAge: age * 1000, httpOnly: true, secure: true, sameSite: 'None'});
        res.status(201).json({ status: true, message: "Congratulations!!! on signing up, proceed to verify your identity", data: {} });
    } catch (err) {
        let errors = showError(err);
        res.status(400).json(errors);
    }
}

module.exports.post_login = async(req, res) => {
    const { email, password, remember, code } = req.body;
    try {
        const user = await userModel.login(email, password);

        if (code) {
            let redisOtp = await redisClient.get(email);
            if (redisOtp == code) {
                const token = createToken(user._id);
                if (remember === true) {
                    res.cookie('token', token, { maxAge: age * 1000, httpOnly: true, secure: true, sameSite: 'None' });
                } else {
                    res.cookie('token', token, { httpOnly: true, secure: true, sameSite: 'None' });
                }
                res.status(200).json({ status: true, message: "", data: {} });
            } else {
                throw Error("Verification failed. Incorrect or expired one time password");
            }
        } else {
            const otp_code = otp.generate(6, { digits: true, lowerCaseAlphabets: false, upperCaseAlphabets: false, specialChars: false });
            const result = await sendOtp(otp_code, email, user.firstname);;
            console.log(otp_code);
            if(redisClient.isReady){
                redisClient.setEx(email, 60 * 15, otp_code);
            }
            res.status(200).json({ status: true, message: result, data: {} });
        }
    } catch (err) {
        console.log(err);
        let errors = showError(err);
        res.status(422).json(errors);
    }
}

module.exports.get_logout = (req, res) => {
    res.cookie('token', ' ', { maxAge: 1, httpOnly: true, secure: true });
    res.redirect('/login');
}

module.exports.post_user_contact = async(req, res) => {
    try {
        const { firstname, lastname, email} = res.locals.data;
        const {message, notifyMe} = req.body;
        const response = await sendContactResponse(`${firstname} ${lastname}`, email, message);
        res.status(200).json({status: true, message: response, data: {}})
    } catch (error) {
        res.status(400).json({status: false, message: "Unable to reach support. Please retry after sometime", data: {}});
        console.log(error);
    }
};

module.exports.post_contact = async(req, res) => {
    try {
        const { name, email, message } = req.body;
        await sendContactResponse(name, email, message);
        res.status(200).json({status: true, message: 'Message recieved, we will get back to you shortly.', data: {}})
    } catch (error) {
        console.log(error);
        res.status(422).json({status: false, message: 'unable to send message, please try after sometime.', data: {}});
    }
};

module.exports.verify_email = async(req, res) => {
    try {
        const { email, name } = req.body;
        const otp_code = otp.generate(6, { digits: true, lowerCaseAlphabets: false, upperCaseAlphabets: false, specialChars: false });
        const result = await sendOtp(otp_code, email, name);;
        console.log(otp_code);
        if(redisClient.isReady){
            redisClient.setEx(email, 60 * 15, otp_code);
        }
        res.status(200).json({ status: true, message: result, data: {} });
    } catch (error) {
        console.log(error.message);
        res.status(400).json({ status: false, message: error.message, data: {} });
    }
};

module.exports.post_reset_password = async(req, res) => {
    let { token, id } = req.params;
    let { password } = req.body;

    try {
        const user = await userModel.findById(id);
        if (user) {
            let decodedToken = jwt.verify(token, secret + user.password);
            const new_user = await userModel.reset_password(decodedToken.id, password);
            const new_token = createToken(new_user._id);
            res.cookie('token', new_token, { maxAge: age * 1000, httpOnly: true, secure: true });
            res.redirect('/dashboard');
        } else {
            throw Error('user not found');
        }

    } catch (error) {
        console.log(error);
        res.status(405);
        res.send('invalid token');
    }
}

module.exports.get_reset_password = async(req, res) => {
    try {
        let { token, id } = req.params;
        const user = await userModel.findById(id);
        if (user) {
            let decodedToken = jwt.verify(token, secret + user.password);
            res.locals.title = "Reset";
            res.locals.year = (new Date().getUTCFullYear())
            res.render('reset');
        } else {
            throw Error('user not found');
        }
    } catch (error) {
        res.send('<html><head><title>Reset Password</title></head><body><p>link is broken, click <a href="/login">here</a> and try resetting passowrd again</p></body></html>');
    }
}

module.exports.post_send_reset_password_mail = async(req, res) => {
    const { email } = req.body;
    try {
        const user = await userModel.find_mail(email);
        const token = createResetToken(user);
        let success = await sendResetToken(email, user.firstname, token, user._id);
        res.status(201).json({status: true, message: success, data: {} });
    } catch (err) {
        let errors = showError(err);
        res.status(400).json(errors);
    }
}

module.exports.get_settings = async(req, res) => {
    if (shouldRenderDashboardInstead(req)) {
        renderDashboard(res);
    } else {
        try {
            const result = res.locals.data
            res.status(200).json({status: true, message: '', data: {
                notification: result.settings.notification, 
                currency: result.settings.currency, 
                language: result.settings.language, 
                address: result.address, 
                mobile: result.mobile, 
                email: result.email
            }});
        } catch (error) {
            res.status(422).json({ status: false, message: error.message, data: {} });
        }
    }
}

module.exports.get_verification = async(req, res) => {
    if (shouldRenderDashboardInstead(req)) {
        renderDashboard(res);
    } else {
        try {
            const result = res.locals.data
            res.status(200).json({status: true, message: '', data: {status: result.status }});
        } catch (error) {
            res.status(422).json({ status: false, message: error.message, data: {} });
        }
    }
}

module.exports.get_purchase_plan = async(req, res) => {
    if (shouldRenderDashboardInstead(req)) {
        renderDashboard(res);
    } else {
        try {
            const result = res.locals.data
            res.status(201).json({status: true, message: '', data: {balance: result.account.balance}});
        } catch (error) {
            res.status(422).json({ status: false, message: error.message, data: {} });
        }
    }
}

module.exports.post_update_settings = async(req, res) => {
    const {notification, currency, language, address, mobile, email } = req.body;
    let updateFields = {};
    let didSendOtp = false;

    if (!isStringEmptyOrWhitespace(address)) updateFields['address'] = address;
    if (!isStringEmptyOrWhitespace(mobile)) updateFields['mobile'] = mobile;
    updateFields['settings.notification'] = notification
    updateFields['settings.currency'] = currency
    updateFields['settings.language'] = language

    try {
        // Ensure there's something to update
        if (Object.keys(updateFields).length === 0) {
            throw new Error('No fields to update');
        }

        if(currency != res.locals.data.settings.currency) {
            const user = await userModel.findById(res.locals.data._id, 'account settings');
            let converted = 0;
            if (user.settings.currency == "euro") {
                user.settings.currency = "eur";
            }
            
            if (user.account.earnings > 0) {
                converted = await currencyConverter.from(user.settings.currency).to(currency).setDecimalComma(false).convert(user.account.earnings);
                updateFields['account.earnings'] = converted;
            }

            if(user.account.ref_bonus > 0) {
                converted = await currencyConverter.from(user.settings.currency).to(currency).setDecimalComma(false).convert(user.account.ref_bonus);
                updateFields['account.ref_bonus'] = converted;
            }

            if (user.account.balance != 0) {
                if (user.account.balance < 1) {
                    converted = user.account.balance * (-1)
                    converted = await currencyConverter.from(user.settings.currency).to(currency).setDecimalComma(false).convert(converted);
                    converted = converted * (-1)
                    updateFields['account.balance'] = converted;
                } else {
                    converted = await currencyConverter.from(user.settings.currency).to(currency).setDecimalComma(false).convert(user.account.balance);
                    updateFields['account.balance'] = converted;
                }
            }
        }

        // Perform the update operation
        const result = await userModel.findByIdAndUpdate(
            res.locals.data._id,
            { $set: updateFields },
            { new: true } // Return the updated document
        );

        if (!result) {
            throw new Error('User not found');
        }

        if(email != res.locals.data.email) {
            const otp_code = otp.generate(6, { digits: true, lowerCaseAlphabets: false, upperCaseAlphabets: false, specialChars: false });
            const result = await sendOtp(otp_code, email, name);;
            didSendOtp = true;
            console.log(otp_code);
            if(redisClient.isReady){
                redisClient.setEx(res.locals.data.email, 60 * 15, otp_code);
            }
        }

        res.status(201).json({status: true, sent_otp: didSendOtp, message: 'Settings updated successfully', data: {
            notification: result.settings.notification, 
            currency: result.settings.currency, 
            language: result.settings.language, 
            address: result.address, 
            mobile: result.mobile, 
            email: email
        }});
    } catch (error) {
        res.status(422).json({ status: false, sent_otp: didSendOtp, message: error.message, data: {} });
    }
}

module.exports.post_update_email = async(req, res) => {
    const {code, email } = req.body;
    let updateFields = {};

    if (!isStringEmptyOrWhitespace(email)) updateFields['email'] = email;

    try {
        // Ensure there's something to update
        if (Object.keys(updateFields).length === 0) {
            throw new Error('No fields to update');
        }

        let redisOtp = await redisClient.get(res.locals.data.email);
        
        if (redisOtp == code) {
            // Perform the update operation
            const result = await userModel.findByIdAndUpdate(
                res.locals.data._id,
                { $set: updateFields },
                { new: true } // Return the updated document
            );

            if (!result) {
                throw new Error('User not found');
            }

            res.status(201).json({status: true, message: 'Email updated successfully', data: {}});
        } else {
            throw Error("Verification failed. Incorrect or expired one time password");
        }
    } catch (error) {
        const errorFormat = showError(error);
        res.status(422).json({ status: false, message: errorFormat.email, data: {} });
    }
}

module.exports.post_purchase_plan = async(req, res) => {
    const user = res.locals.data;
    const {title, amount} = req.body;

    try {
        if (amount > user.account.balance) {
            throw Error("Balance is too low to purchase selected plan")
        }
        if (isStringEmptyOrWhitespace(title)) {
            throw Error("Invalid plan type");
        }

        const newPlan = {amount, date: (new Date().toISOString), type: title};
        
        const updatedUser = await userModel.updateOne(
            { _id: user._id },
            {
                // $set: { 
                //     "account.balance": newBalance,
                //     "account.active_plans": activePlans
                // },
                $inc: { 
                    "account.balance": -amount,
                    "account.active_plans": 1
                },
                $push: {
                    "plans": newPlan  // Insert a new plan into the plans array
                }
            },
            { new: true }
        );

        if(updatedUser) {
            await sendPlanPurchase(updatedUser.email, updatedUser.firstname, title)
            res.status(201).json({status: true, message: "Plan purchased successfully!", data: {}});
        } else {
            throw Error("Unable to purchase plan");
        }
    } catch (error) {
        res.status(422).json({status: false, message: error.message, data: {}});
        console.log(error);
    }
}

module.exports.verify_otp = async(req, res) => {
    const {email, otp} = req.body;
    try {
        let redisOtp = await redisClient.get(email);
        if (redisOtp == otp) {
            res.status(200).json({status: true, message: "Verification successfull!", data: {}});
        } else {
            throw Error("Verification failed. Incorrect or expired one time password");
        }
    } catch(error) {
        res.status(200).json({status: false, message: error.message, data: {}});
    }
}

module.exports.jwt_secret = secret;
module.exports.createToken = createToken;
module.exports.showError = showError;
