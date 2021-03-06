import nativeMethods from './sandbox/native-methods';
import settings from './settings';
import XhrSandbox from './sandbox/xhr';
import { stringify as stringifyJSON, parse as parseJSON } from './json';
import { isWebKit } from './utils/browser';
import Promise from 'pinkie';

const SERVICE_MESSAGES_WAITING_INTERVAL = 50;

class Transport {
    constructor () {
        this.msgQueue                     = {};
        this.activeServiceMessagesCounter = 0;
    }

    static _storeMessage (msg) {
        const storedMessages = Transport._getStoredMessages();

        storedMessages.push(msg);

        nativeMethods.winLocalStorageGetter.call(window).setItem(settings.get().sessionId, stringifyJSON(storedMessages));
    }

    static _getStoredMessages () {
        const storedMessagesStr = nativeMethods.winLocalStorageGetter.call(window).getItem(settings.get().sessionId);

        return storedMessagesStr ? parseJSON(storedMessagesStr) : [];
    }

    static _removeMessageFromStore (cmd) {
        const messages = Transport._getStoredMessages();

        for (let i = 0; i < messages.length; i++) {
            if (messages[i].cmd === cmd) {
                messages.splice(i, 1);

                break;
            }
        }

        nativeMethods.winLocalStorageGetter.call(window).setItem(settings.get().sessionId, stringifyJSON(messages));
    }

    _sendNextQueuedMsg (queueId) {
        const queueItem = this.msgQueue[queueId][0];

        this.asyncServiceMsg(queueItem.msg)
            .then(res => {
                if (queueItem.callback)
                    queueItem.callback(res);

                this.msgQueue[queueId].shift();

                if (this.msgQueue[queueId].length)
                    this._sendNextQueuedMsg(queueId);
            });
    }

    // TODO: Rewrite this using Promise after getting rid of syncServiceMsg.
    _performRequest (msg, callback) {
        msg.sessionId = settings.get().sessionId;

        if (isIframeWithoutSrc)
            msg.referer = settings.get().referer;

        const sendMsg = forced => {
            this.activeServiceMessagesCounter++;

            const isAsyncRequest = !forced;
            const transport      = this;
            let request          = XhrSandbox.createNativeXHR();
            const msgCallback    = function () {
                transport.activeServiceMessagesCounter--;

                const response = this.responseText && parseJSON(this.responseText);

                request = null;
                callback(response);
            };
            const errorHandler   = function () {
                if (msg.disableResending)
                    return;

                if (isWebKit) {
                    Transport._storeMessage(msg);
                    msgCallback.call(this);
                }
                else
                    sendMsg(true);
            };

            XhrSandbox.openNativeXhr(request, settings.get().serviceMsgUrl, isAsyncRequest);

            if (forced) {
                request.addEventListener('readystatechange', function () {
                    if (this.readyState !== 4)
                        return;

                    msgCallback.call(this);
                });
            }
            else {
                request.addEventListener('load', msgCallback);
                request.addEventListener('abort', errorHandler);
                request.addEventListener('error', errorHandler);
                request.addEventListener('timeout', errorHandler);
            }

            request.send(stringifyJSON(msg));
        };

        Transport._removeMessageFromStore(msg.cmd);
        sendMsg();
    }

    waitForServiceMessagesCompleted (timeout) {
        return new Promise(resolve => {
            if (!this.activeServiceMessagesCounter) {
                resolve();
                return;
            }

            let intervalId  = null;
            const timeoutId = window.setTimeout(() => {
                nativeMethods.clearInterval.call(window, intervalId);
                resolve();
            }, timeout);

            intervalId = window.setInterval(() => {
                if (!this.activeServiceMessagesCounter) {
                    nativeMethods.clearInterval.call(window, intervalId);
                    nativeMethods.clearTimeout.call(window, timeoutId);
                    resolve();
                }
            }, SERVICE_MESSAGES_WAITING_INTERVAL);
        });
    }

    asyncServiceMsg (msg) {
        return new Promise(resolve => {
            this._performRequest(msg, data => resolve(data));
        });
    }

    batchUpdate () {
        const storedMessages = Transport._getStoredMessages();

        if (storedMessages.length) {
            const tasks = [];

            nativeMethods.winLocalStorageGetter.call(window).removeItem(settings.get().sessionId);

            for (const storedMessage of storedMessages)
                tasks.push(this.queuedAsyncServiceMsg(storedMessage));

            return Promise.all(tasks);
        }
        return Promise.resolve();
    }

    queuedAsyncServiceMsg (msg) {
        return new Promise(resolve => {
            if (!this.msgQueue[msg.cmd])
                this.msgQueue[msg.cmd] = [];

            this.msgQueue[msg.cmd].push({
                msg:      msg,
                callback: resolve
            });

            // NOTE: If we don't have pending messages except the current one, send the latter immediately.
            if (this.msgQueue[msg.cmd].length === 1)
                this._sendNextQueuedMsg(msg.cmd);
        });
    }
}

export default new Transport();
