'use strict';

const CAPABILITY = 'garagedoor_closed';
const STATE_CAPABILITY = 'garage_door_state';
const OPEN_CAPABILITY = 'button.open';
const CLOSE_CAPABILITY = 'button.close';
const DEVICE_CAPABILITIES = Object.freeze([STATE_CAPABILITY, OPEN_CAPABILITY, CLOSE_CAPABILITY, CAPABILITY]);

function isMsg100(model) {
    return typeof model === 'string' && /^msg100(?:[a-z-][a-z0-9-]*)?$/i.test(model.trim());
}

function pairingDevice(accountId, row, physical) {
    if (typeof accountId !== 'string' || !accountId || !physical || !isMsg100(physical.model)
        || typeof physical.uuid !== 'string' || !physical.uuid || row?.classHint !== 'cover'
        || !Array.isArray(row.traits) || !row.traits.includes('cover')
        || typeof row.id !== 'string' || !row.id.startsWith(`${physical.uuid}:`)
        || !/^\d+$/.test(row.id.slice(physical.uuid.length + 1))) {
        return null;
    }
    return {
        name: physical.name || row.name || 'MSG100 garage door',
        data: { id: `${accountId}:${row.id}` },
        store: { accountId, uuid: physical.uuid, endpointId: row.id },
        capabilities: [...DEVICE_CAPABILITIES]
    };
}

function identity(data, store) {
    if (!store || !['accountId', 'uuid', 'endpointId'].every(key => typeof store[key] === 'string' && store[key])
        || data?.id !== `${store.accountId}:${store.endpointId}`
        || !store.endpointId.startsWith(`${store.uuid}:`)
        || !/^\d+$/.test(store.endpointId.slice(store.uuid.length + 1))) {
        throw new Error('This opener has incomplete account details. Add the MSG100 again.');
    }
    return { accountId: store.accountId, uuid: store.uuid, endpointId: store.endpointId, ownerId: data.id };
}

function credentials(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.email !== 'string' || !value.email.trim()
        || typeof value.password !== 'string' || !value.password) {
        throw new Error('Enter the email address and password used in your Meross app.');
    }
    const mfaCode = typeof value.mfaCode === 'string' ? value.mfaCode.trim() : '';
    if (mfaCode && !/^\d{6}$/.test(mfaCode)) {
        throw new Error('Enter the current six-digit code from your authenticator app.');
    }
    return { email: value.email.trim(), password: value.password, ...(mfaCode ? { mfaCode } : {}) };
}

function loginChallenge(error) {
    if (error?.code === 'MFA_REQUIRED' || error?.apiStatus === 1033) return { status: 'mfa_required' };
    if (error?.code === 'MFA_WRONG' || error?.apiStatus === 1032) return { status: 'mfa_wrong' };
    return null;
}

function friendlyError(error) {
    if (error?.code === 'TOKEN_EXPIRED') return 'Your Meross session has expired. Open this device’s repair screen to sign in again.';
    if (error?.code === 'TOO_MANY_TOKENS') return 'Meross has reached its login-session limit. Close unused Meross sessions and try again.';
    if (error?.code === 'WRONG_ACCOUNT') return 'Sign in to the same Meross account used to add this opener.';
    if (['CANCELLED', 'PAIRING_CANCELLED', 'LOGIN_CANCELLED'].includes(error?.code)) return 'This sign-in attempt was cancelled. Try again.';
    if (error?.code === 'AUTHENTICATION') return 'Meross could not verify these details. Check your email address and password, then try again.';
    return 'Could not connect to Meross. Check the Meross app and your network connection, then try again.';
}

function closedValue(values) {
    return typeof values?.open === 'boolean' ? !values.open : undefined;
}

function requireGarage(endpoint) {
    if (endpoint?.cover?.kind !== 'garage'
        || typeof endpoint.cover.open !== 'function' || typeof endpoint.cover.close !== 'function'
        || typeof endpoint.cover.values !== 'function' || typeof endpoint.cover.poll !== 'function') {
        throw new Error('This endpoint does not report an MSG100 garage-door control.');
    }
    return endpoint.cover;
}

module.exports = { CAPABILITY, STATE_CAPABILITY, OPEN_CAPABILITY, CLOSE_CAPABILITY, DEVICE_CAPABILITIES,
    isMsg100, pairingDevice, identity, credentials, loginChallenge, friendlyError, closedValue, requireGarage };
