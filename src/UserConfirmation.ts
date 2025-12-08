import { Devvit , TriggerContext, Context } from "@devvit/public-api";
import {AppSettings, getAppSettings} from "./main.js";

export interface ConfirmationResults {
  username: string;
  timeStarted?: Date;
  notified?: boolean;
  timeNotified?: Date;
  notificationModmailId?: string;
  human?: boolean;
  bot?: boolean;
  chatgpt?: 'yes' | 'sometimes' |'no';
  usernameConfirm?: string;
  tokenDisplayed?: string;
  tokenEntered?: string;
  fakeTokenEntered? : string;
  understand?: boolean;
  timeCompleted?: Date;
  timeLapseSeconds?: number;
  verificationStatus?: 'verified' | 'pending' | 'timeout' | 'failed' | 'unverified';
  modOverridenStatus?: boolean;
}

export const confirmForm = Devvit.createForm(
  (data) => {
    const confirmationResults = parseConfirmationResultsWithDates(data.confirmationResults) as ConfirmationResults;
    return {
      fields: [
        {
            name: "human",
            label: "I Am Human",
            type: "boolean",
            defaultValue: false,
            required: true,
        },
        {
            name: "bot",
            label: "I Am a Bot",
            type: "boolean",
            defaultValue: true,
            required: true,
        },
        {
            name: "chatgpt",
            label: "Chat-GPT/AI?",
            helpText: "Do you use Chat-GPT or other AI tools to help you compose posts or comments?",
            type: "select",
            options: [
              { label: "Yes", value: "yes" },
              { label: "No", value: "no" },
              { label: "Sometimes", value: "sometimes" },
            ],
            defaultValue: [],
            required: true,
        },
        {
            name: "usernameConfirm",
            label: "Username Confirmation",
            type: "select",
            helpText: "Select your username from the list",
            options: generateUsernameOptions(confirmationResults.username),
            defaultValue: [],
            required: true,
        },
        {
            type: "group",
            name: "tokenChallengeGroup",
            label: "Token Entry (⚠️ read instructions carefully)",
            fields: [
                {
                    name: "realTokenChallenge",
                    label: "Please enter this token: T-" + confirmationResults.tokenDisplayed + " (without the 'T-')", 
                    type: "string",
                    defaultValue: "",
                    helpText: "Leave this field blank!",
                },
                {
                    name: "fakeTokenChallenge",
                    label: "Please enter this token: T-" + confirmationResults.tokenDisplayed + " (without the 'T-')",
                    type: "string",
                    defaultValue: "",
                    helpText: "Enter the token here",
                },
            ]
        },
        {
          name: "understand",
          label: "⚠️ I understand that if I am found to be a bot, I may be banned.",
          type: "boolean",
          defaultValue: false,
          required: true,
        }
      ],
      title: "Confirm Human",
      acceptLabel: "Confirm",
      cancelLabel: "Cancel",
    }
  },
  async ({ values }, context) => {
    let confirmationResults = await getConfirmationResults(context, context.username || '') as ConfirmationResults;
    confirmationResults.timeCompleted = new Date();
    confirmationResults.timeLapseSeconds = (confirmationResults.timeCompleted.getTime() - (confirmationResults.timeStarted ? confirmationResults.timeStarted.getTime() : confirmationResults.timeCompleted.getTime())) / 1000;
    confirmationResults.human = values.human;
    confirmationResults.bot = values.bot;
    confirmationResults.chatgpt = Array.isArray(values.chatgpt) ? values.chatgpt[0] : values.chatgpt;

    const appSettings = await getAppSettings(context);
    if(Array.isArray(values.usernameConfirm)) {
      confirmationResults.usernameConfirm = values.usernameConfirm[0].replace('user_', '');
    } else {
      confirmationResults.usernameConfirm = values.usernameConfirm.replace('user_', '');
    }
    confirmationResults.tokenEntered = values.fakeTokenChallenge;
    confirmationResults.fakeTokenEntered = values.realTokenChallenge;
    //determine if they passed
    let passed = true;
    let failureReport = '----- ❎ u/' + confirmationResults.username + ' Failure Report -----';
    let reportClose = '';
    for(let i = 0; i < failureReport.length; i++) {
        reportClose += '-';
    }
    failureReport += '\n';
    //let unsure = false;
    //TODO check time to open form and time to complete form against min times in settings
    if(!confirmationResults.human || confirmationResults.bot) {
        passed = false;
        failureReport += (!confirmationResults.human ? "Human Not Selected\n" : "")
                      + (confirmationResults.bot ? "Bot Selected\n" : "");
    }
    if(appSettings.failVerificationIfChatGPTUsed && confirmationResults.chatgpt !== 'no') {
        passed = false;
        failureReport += "ChatGPT/AI Usage: \""+  confirmationResults.chatgpt + "\"\n";
        //TODO should this be considered unsure if !appSettings.failVerificationIfChatGPTUsed?
    }
    if(!checkUsernameEntry(confirmationResults.username, confirmationResults.usernameConfirm || '')) {
        passed = false;
        failureReport += "Actual Username:   \""+  confirmationResults.username + "\"\n";
        failureReport += "Username Selected: \""+  confirmationResults.usernameConfirm + "\"\n";
    }
    if(!checkTokenEntry(confirmationResults.tokenEntered, confirmationResults.tokenDisplayed)) {
        passed = false;
        failureReport += "Token Entered:   \""+  confirmationResults.tokenEntered + "\"\n";
        failureReport += "Token Displayed: \""+  confirmationResults.tokenDisplayed + "\"\n";
    }
    if(confirmationResults.fakeTokenEntered && confirmationResults.fakeTokenEntered.trim() !== '') {
        passed = false;
        failureReport += "Fake Token Entered:\t\""+  confirmationResults.fakeTokenEntered + "\"\n";
    }
    if(!values.understand) {
        //unsure = true;
        //TODO should this be a failure?
        passed = false;
        failureReport += "Understand Confirmation Not Selected\n";
    }
    //if(unsure) {
        //TODO show advanced check form (to be implemented) - or something else?
        //return;
    //}

    confirmationResults.verificationStatus = passed ? 'verified' : 'failed';
    await setConfirmationResults(context, confirmationResults.username, confirmationResults);

    if(passed) {
        console.log('✅ u/' + confirmationResults.username + ' verification successul!');
        context.ui.showToast({text: '✅ Human verification successful!', appearance: 'success'});
        return;
    }
    else {
        console.log('❎ u/' + confirmationResults.username + ' verification failed');
        failureReport = '\n\n' + failureReport + reportClose + '\n\n';
        if(!passed) console.log(failureReport);
        //show toast for failure?
    }
    
    if(!passed && appSettings.banOnFailedVerification) {
        console.log(`User u/${confirmationResults.username} has failed verification. Banning user`);
        await context.reddit.banUser({
            username: confirmationResults.username,
            subredditName: context.subredditName || '',
            reason: 'Failed human verification, banned automatically',
            message: 'You have been banned for failing the human verification process. If you believe this is a mistake, please reply to this modmail.',
        });
        return;
    }
  }
);

function checkUsernameEntry(username: string, usernameConfirm: string): boolean {
    //strip u/ if present
    if(usernameConfirm.startsWith('u/')) {
      usernameConfirm = usernameConfirm.substring(2);
    }
    return username === usernameConfirm;
}
function checkTokenEntry(tokenEntered: string | undefined, tokenExpected: string | undefined): boolean {
    //pass if tokens match, even if they are different cases or there's extra whitespace
    if(tokenEntered) tokenEntered = tokenEntered.toLowerCase().trim();
    if(tokenExpected) tokenExpected = tokenExpected.toLowerCase().trim();
    return tokenEntered === tokenExpected;
}

export const confirmationDoneForm = Devvit.createForm(
  (data) => {
    let confirmationResults = parseConfirmationResultsWithDates(data.confirmationResults) as ConfirmationResults;
    let appSettings = JSON.parse(data.appSettings);
    return {
      fields: [
        {
            name: "status",
            label: "Confirmation Status",
            type: "string",
            defaultValue: getUserVerificationStatus(confirmationResults),
            helpText: getUserVerificationHelpText(appSettings, confirmationResults),
            disabled: true,
        },
        //TODO allow retries in certain cases?
      ],
      title: "Human Confirmation Result",
      acceptLabel: "OK",
      cancelLabel: "Close",
    }
  },
  async ({ values }, context) => {
    //Do nothing, I guess?
  }
);

function getUserVerificationStatus(confirmationResults: ConfirmationResults): string {
  let status = '';
  const verified = confirmationResults.verificationStatus === 'verified';
  const failed = confirmationResults.verificationStatus === 'failed';
  const timeout = confirmationResults.verificationStatus === 'timeout';
  if(verified) {
    status = `u/${confirmationResults.username} Verified 🟢`;
  }
  else if(failed) {
    status = `u/${confirmationResults.username} Verification Failed 🔴`;
  }
  else if(timeout) {
    status = `u/${confirmationResults.username} Verification Timed Out 🟠`;
  }
  else { 
    //should never get here, but just in case
    status = `u/${confirmationResults.username} Verification Unknown ⚪️`;
  }
  return status;
}

function getUserVerificationHelpText(appSettings: AppSettings, confirmationResults: ConfirmationResults): string {
  let helpText = '';
  const verified = confirmationResults.verificationStatus === 'verified';
  const failed = confirmationResults.verificationStatus === 'failed';
  const timeout = confirmationResults.verificationStatus === 'timeout';
  if(verified) {
    helpText = "You should not be blocked by posting/commenting (except from other potential rule filters)";
  }
  else if(failed) {
    helpText = "You are " + (appSettings.actionOnPendingVerification !== 'remove' ? "" : "still ") + "blocked from posting/commenting. Please contact the moderators if you believe this is a mistake.";
  }
  else if(timeout) {
    if(appSettings.actionOnTimeoutVerification !== 'remove') {
      helpText = "You are " + (appSettings.actionOnPendingVerification !== 'remove' ? "" : "still ") + "blocked from posting/commenting. Please contact the moderators if you believe this is a mistake.";
    }
    else {
      helpText = "You should not be blocked by posting/commenting (except from other potential rule filters)";
    }
  }
  return helpText;
}

Devvit.addMenuItem({
  label: "Confirm Human",
  description:
    "Prevent potential blocks from posting and commenting",
  location: "subreddit",
  onPress: async (event, context) => {
    console.log(`Menu item 'Verify Human' pressed:\n${JSON.stringify(event)}`);
    const username = (await context.reddit.getCurrentUser())?.username || '';
    if(!username) {
      console.log('Current username not found for verification.');
      return;
    }

    const appSettings = await getAppSettings(context);
    let confirmationResults = await getConfirmationResults(context, username) as ConfirmationResults;
    if(!appSettings.allowConfirmingWithoutNotification && (!confirmationResults || !confirmationResults.notified)) {
        console.log(`User u/${username} has not been notified for verification yet, and not allowed without mod request, so blocked`);
        context.ui.showToast('You must wait to be notified by a moderator request before you can confirm you are human');
        return;
    }
    if(confirmationResults.verificationStatus === 'verified' || confirmationResults.verificationStatus === 'failed' || confirmationResults.verificationStatus === 'timeout') {
      context.ui.showForm(confirmationDoneForm, {appSettings: JSON.stringify(appSettings), confirmationResults: JSON.stringify(confirmationResults)});
      return;
    }
    await startHumanConfirmationProcess(context, username, confirmationResults);
  }
});

async function startHumanConfirmationProcess(context: Context, username: string, confirmationResults: ConfirmationResults): Promise<void> {
    if(!confirmationResults) {  
      confirmationResults = {
        username: username,
        timeStarted: new Date(),
        tokenDisplayed: generateRandomToken(),
      };
      await setConfirmationResults(context, username, confirmationResults);
    }
    if(confirmationResults.verificationStatus === 'verified' || confirmationResults.verificationStatus === 'failed') {
      context.ui.showForm(confirmationDoneForm , {confirmationResults: JSON.stringify(confirmationResults)});
      return;
    }
    
    if(confirmationResults.verificationStatus === 'pending') {
      //reset start time and token
      confirmationResults.timeStarted = new Date();
      confirmationResults.tokenDisplayed = generateRandomToken();
      await setConfirmationResults(context, username, confirmationResults);
    }
    else {
      //check if timed out since notified
      const pendingTimeoutMinutes = (await getAppSettings(context)).pendingConfirmationTimeoutMinutes;
      if(pendingTimeoutMinutes > 0 && 
         confirmationResults.timeNotified && 
         (new Date().getTime() - confirmationResults.timeNotified.getTime()) / 1000 > pendingTimeoutMinutes * 60) {
        confirmationResults.verificationStatus = 'timeout';
        await setConfirmationResults(context, username, confirmationResults);
        context.ui.showForm(confirmationDoneForm , {confirmationResults: JSON.stringify(confirmationResults)});
        return;
      }
      
      confirmationResults.tokenDisplayed = generateRandomToken();
      //otherwise set to pending to start verification
      //confirmationResults.verificationStatus = 'pending'; only set to pending on request or else they may timeout just by looking and cancelling
      if(!confirmationResults.timeStarted) {
        confirmationResults.timeStarted = new Date();
      }
      await setConfirmationResults(context, username, confirmationResults);
    }
    context.ui.showForm(confirmForm , {confirmationResults: JSON.stringify(confirmationResults)});
}

export async function getConfirmationResults(context: Context | TriggerContext , username: string): Promise<ConfirmationResults | boolean> {
  const resultsStr = await context.redis.get('ConfirmationResults:' + username);
  if (resultsStr) {
    return parseConfirmationResultsWithDates(resultsStr) as ConfirmationResults;
  }
  return false;
}
export async function setConfirmationResults(context: Context | TriggerContext , username: string, results: ConfirmationResults): Promise<void> {
  console.log('Setting u/' + username + '\'s confirmation results: ' + JSON.stringify(results));
  await context.redis.set('ConfirmationResults:' + username, JSON.stringify(results));
}
export async function deleteConfirmationResults(context: Context | TriggerContext, username: string): Promise<void> {
  console.log('Deleting u/' + username + '\'s confirmation results');
  await context.redis.del('ConfirmationResults:' + username);
}

export function parseConfirmationResultsWithDates(resultsStr: string): ConfirmationResults {
    let confirmationResults = JSON.parse(resultsStr) as ConfirmationResults;
    if (confirmationResults && confirmationResults.timeStarted && typeof confirmationResults.timeStarted === 'string') {
        confirmationResults.timeStarted = new Date(confirmationResults.timeStarted);
    }
    if (confirmationResults && confirmationResults.timeCompleted && typeof confirmationResults.timeCompleted === 'string') {
        confirmationResults.timeCompleted = new Date(confirmationResults.timeCompleted);
    }
    return confirmationResults;
}

function generateUsernameOptions(username: string): {label: string, value: string}[] {
  const options = [];
  options.push({label: 'u/' + username, value: 'user_' + username});
  //generate 5 random fake usernames
  for(let i = 0; i < 5; i++) {
    options.push({label: 'u/' + generateRandomToken(), value: 'user_' + generateRandomToken()});
  }
  //shuffle the options
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  return options;
}

function generateRandomToken(): string {
  //generate random length between 3 and 5
  const length = Math.floor(Math.random() * (5 - 3 + 1)) + 3;
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    token += characters.charAt(randomIndex);
  }
  return token;
}