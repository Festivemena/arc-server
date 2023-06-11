import express from 'express';
import mongoose from 'mongoose';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import helmet from 'helmet';
import { validationResult } from 'express-validator';
import morgan from 'morgan';
import dotenv from 'dotenv';

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
const generateAuthHeader = (accessToken) => {
  return {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  };
};

// Define the JWT secret key
const JWT_SECRET = process.env.JWT_SECRET;

// Define an endpoint to obtain the access token and authenticate the user
app.post('/auth/login', async (req, res) => {
  try {
    // Obtain the access token from Monnify
    const response = await axios.post(`${BASE_URL}/v1/auth/login`, {
        apiKey: API_KEY,
        secretKey: SECRET_KEY,
      },
      generateAuthHeader(req.body.accessToken));

      const accessToken = response.data.responseBody.accessToken;
      consol.log(accessToken);

    // Store the user data in MongoDB
    const { name, email, password } = req.body;
    const user = new User({ name, email, password });
    await user.save();

    // Create a reserved account
    const accountResponse = await axios.post(
      `${BASE_URL}/v2/bank-transfer/reserved-accounts`,
      {
        "accountReference" : user._id, // Use the user's MongoDB _id as the account reference
        "accountName" : user.name,
        "currencyCode" : "NGN",
        "contractCode" : CONTRACT_CODE,
        "customerEmail": user.email,
        "customerName": user.name,
        "getAllAvailableBanks": false,
        "preferredBanks": ["035"],
      },
      generateAuthHeader(accessToken)
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
app.post('/transfers', async (req, res) => {
  try {
    const { senderAccountReference, recipientAccountNumber, amount } = req.body;

    // Authenticate and obtain the access token
    const authResponse = await axios.post(`${BASE_URL}/auth/login`, {
      apiKey: API_KEY,
      secretKey: SECRET_KEY,
    });
    const accessToken = authResponse.data.responseBody.accessToken;

    // Fetch the sender's reserved account details
    const accountResponse = await axios.get(
      `${BASE_URL}/reservedaccounts/${senderAccountReference}`,
      generateAuthHeader(accessToken)
    );
    const senderAccount = accountResponse.data.responseBody;

    // Perform the bank transfer
    const transferResponse = await axios.post(
      `${BASE_URL}/transfers`,
      {
        amount,
        debitAccountReference: senderAccount.accountReference,
        debitAccountName: senderAccount.accountName,
        creditAccountNumber: recipientAccountNumber,
        narration: 'Funds transfer',
      },
      generateAuthHeader(accessToken)
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
