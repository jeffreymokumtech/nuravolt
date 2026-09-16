import { EventEmitter } from 'events';
import { resendService } from './../libs/resend'

const emailEvents = new EventEmitter();

emailEvents.on('sendThanksYouEmail', async (email: string) => {
    resendService.sendThanksYouEmail(email)
});

export default emailEvents;
