'use strict';

const Homey = require('homey');
const { Session } = require('node-meross-sdk');
const { Accounts } = require('./lib/accounts');

class MerossConnectApp extends Homey.App {
    async onInit() {
        this.accounts = new Accounts({
            Session,
            settings: this.homey.settings,
            warn: message => this.error(message)
        });
        this.homey.flow.getActionCard('garage_open').registerRunListener(async ({ device }) => {
            await device.requestClosed(false);
        });
        this.homey.flow.getActionCard('garage_close').registerRunListener(async ({ device }) => {
            await device.requestClosed(true);
        });
        this.log('Meross Connect initialized. Saved sessions are restored when devices start.');
    }

    async onUninit() {
        await this.accounts?.close();
    }
}

module.exports = MerossConnectApp;
