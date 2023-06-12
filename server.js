import express, { response } from 'express';
import mongoose from 'mongoose';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import helmet from 'helmet';
import { validationResult } from 'express-validator';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { v4 } from 'uuid';

dotenv.config();

const app = express();
const API_KEY = process.env.MONNIFY_API_KEY;
const SECRET_KEY = process.env.MONNIFY_SECRET_KEY;
const BASE_URL = process.env.BASE_URL;
const CONTRACT_CODE = process.env.CONTRACT_CODE;

// Configure Express to parse JSON
app.use(express.json());

// Configure Helmet for secure headers
app.use(helmet());

// Configure Morgan for request logging
app.use(morgan('combined'));

// Set up the MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI;
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const db = mongoose.connection;

db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => {
  console.log('Connected to MongoDB');
});

// Define a User model using Mongoose
const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  password: {
    type: String,
    required: true,
  },
  accountReference: {
    type: String,
    default: null,
  },
});

const User = mongoose.model('User', userSchema);

// Function to generate the authorization header with the access token
const generateAuthHeader = () => {
  return {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${API_KEY}:${SECRET_KEY}`).toString('base64')}`,
    },
  };
};

const generateReservedHeader = (accessToken) => {
    return {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    };
  };

// Define the JWT secret key
const JWT_SECRET = process.env.JWT_SECRET;

// Define an API endpoint for user login
app.post('/login', async (req, res) => {
  try {
    const { name, password } = req.body;

    // Query the database for the user
    const user = await User.findOne({ name });
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Generate the token
    const token = jwt.sign({ userId: user._id }, JWT_SECRET);

    // Obtain the access token from Monnify
    const response = await axios.post(`${BASE_URL}/v1/auth/login`, {
      apiKey: API_KEY,
      secretKey: SECRET_KEY,
    });

    // Store the access token
    const accessToken = response.data.responseBody.accessToken;

    // Retrieve user's account details from Monnify API
    const accountResponse = await axios.get(`${BASE_URL}/v1/bank-transfer/reserved-accounts/${user.accountReference}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const accountDetails = accountResponse.data.responseBody;

    // Update the MongoDB user document with the account details
    user.accountDetails = accountDetails;
    await user.save();

    // Send the token and user data in the response
    res.json({ token, user });
  } catch (error) {
    console.error('Error:', error);

    if (error.response) {
      // Monnify API error
      const errorMessage = error.response?.data?.message || 'An error occurred during login to Monnify';
      res.status(500).json({ message: errorMessage });
    } else {
      // MongoDB error or other server error
      res.status(500).json({ message: 'An error occurred during login' });
    }
  }
});

// Define an endpoint to obtain the access token and authenticate the user
app.post('/auth/login', async (req, res) => {
  try {

     // Store the user data in MongoDB
     const { name, email, password } = req.body;
     const user = new User({ name, email, password });
     await user.save();

    // Obtain the access token from Monnify
    const response = await axios.post(`${BASE_URL}/v1/auth/login`, {
        apiKey: API_KEY,
        secretKey: SECRET_KEY,
      },
      generateAuthHeader(),
      );

    // Store the access token
      const accessToken = response.data.responseBody.accessToken;
     
    // Create a reserved account
    const accountResponse = await axios.post(
      `${BASE_URL}/v2/bank-transfer/reserved-accounts`,
      {
        "accountReference" : user._id, // Use the user's MongoDB _id as the account reference
        "accountName" : user.name,
        "currencyCode" : "NGN",
        "contractCode" : "0648558726",
        "customerEmail": user.email,
        "customerName": user.name,
        "getAllAvailableBanks": false,
        "preferredBanks": ["035"],
      },
      generateReservedHeader(accessToken)
    );
    const accountReference = accountResponse.data.responseBody.accountReference;

    // Update the user with the account reference
    user.accountReference = accountReference;
    await user.save();

    // Generate a JWT token
    const token = jwt.sign({ userId: user._id }, JWT_SECRET);

    // Return the access token, user data, and account reference in the response
    res.json({
      accessToken,
      user,
      accountReference,
      token,
    });
  } catch (error) {
    console.error('Error creating user or reserved account:', error.message);
    res
      .status(500)
      .json({ error: 'Failed to create user or reserved account' });
  }
});


// Define an endpoint to initiate a bank transfer
// Define an endpoint to initiate a bank transfer
app.post('/transfers', async (req, res) => {
  try {
    const { senderAccountReference, recipientAccountNumber, amount } = req.body;

    const response = await axios.post(`${BASE_URL}/v1/auth/login`, {
        apiKey: API_KEY,
        secretKey: SECRET_KEY,
      },
      generateAuthHeader(),
      );

    // Store the access token
      const accessToken = response.data.responseBody.accessToken;

    // Fetch the sender's reserved account details
    const accountResponse = await axios.get(
      `${BASE_URL}/v2/bank-transfer/reserved-accounts/${senderAccountReference}`,
      generateReservedHeader(accessToken)
    );
    
    const senderAccount = accountResponse.data.responseBody;

    const recipientResponse = await axios.get(
      `${BASE_URL}/v1/disbursements/account/validate?accountNumber=${recipientAccountNumber}&bankCode=035`,
      generateReservedHeader(accessToken)
    );
    
    const recipientAccount = recipientResponse.data.responseBody;
    const reference = v4();
    // Perform the bank transfer
    const transferResponse = await axios.post(
      `${BASE_URL}/api/v2/disbursements/single`,
      {
        "amount": amount,
     "reference": reference,
    "narration":"Test01",
    "destinationBankCode": recipientAccount.bankCode,
    "destinationAccountNumber": recipientAccount.accountNumber,
    "currency": "NGN",
    "sourceAccountNumber": senderAccount.accounts.accountNumber,
    "destinationAccountName": recipientAccount.accountName,
      },
      generateReservedHeader(accessToken)
    );

    // Return the transfer response
    res.json(transferResponse.data);
  } catch (error) {
    console.error('Error initiating bank transfer:', error.message);
    res.status(500).json({ error: 'Failed to initiate bank transfer' });
  }
});


// Add additional endpoints and functionality as needed

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
