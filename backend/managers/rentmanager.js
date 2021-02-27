const logger = require('winston');
const axios = require('axios');
const moment = require('moment-timezone');
const Contract = require('./contract');
const FD = require('./frontdata');
const rentModel = require('../models/rent');
const occupantModel = require('../models/occupant');
const config = require('../../config');

const _findOccupants = (realm, occupantId, term) => {
    return new Promise((resolve, reject) => {
        const filter = {
            '$query': {
                '$and': []
            }
        };
        if (occupantId) {
            filter['$query']['$and'].push({ '_id': occupantId });
        }
        if (term) {
            filter['$query']['$and'].push({ 'rents.term': term });
        }
        occupantModel.findFilter(realm, filter, (errors, occupants) => {
            if (errors && errors.length > 0) {
                return reject(errors);
            }

            resolve(occupants
                .map(occupant => {
                    if (term) {
                        occupant.rents = occupant.rents.filter(rent => rent.term === term);
                    }
                    return occupant;
                })
                .sort((o1, o2) => {
                    const name1 = o1.isCompany ? o1.company : o1.name;
                    const name2 = o2.isCompany ? o2.company : o2.name;

                    return name1.localeCompare(name2);
                })
            );
        });
    });
};

const _getEmailStatus = async term => {
    try {
        logger.debug(`get email status ${config.EMAILER_URL}/status/${term}`);
        const response = await axios.get(`${config.EMAILER_URL}/status/${term}`);
        logger.debug(response.data);
        return response.data.reduce((acc, status) => {
            const data = {
                sentTo: status.sentTo,
                sentDate: status.sentDate
            };
            if (!acc[status.recordId]) {
                acc[status.recordId] = { [status.templateName]: [] };
            }
            let documents = acc[status.recordId][status.templateName];
            if (!documents) {
                documents = [];
                acc[status.recordId][status.templateName] = documents;
            }
            documents.push(data);
            return acc;
        }, {});
    } catch (error) {
        if (config.demoMode) {
            logger.info('email status fallback workflow activated in demo mode');
            return {};
        } else {
            throw error.data;
        }
    }
};

const _getRentsDataByTerm = async (realm, monthOfYear) => {
    const term = Number(monthOfYear.startOf('month').format('YYYYMMDDHH'));
    const [dbOccupants, emailStatus = {}] = await Promise.all([
        _findOccupants(realm, null, term),
        _getEmailStatus(term).catch(logger.error)
    ]);

    // compute rents
    const rents = dbOccupants.map(occupant => {
        const rent = occupant.rents.find(rent => rent.term === term);
        return FD.toRentData(
            rent,
            occupant,
            emailStatus && emailStatus[occupant._id]
        );
    });

    // compute rents overview
    const overview = {
        countAll: 0,
        countPaid: 0,
        countPartiallyPaid: 0,
        countNotPaid: 0,
        totalToPay: 0,
        totalPaid: 0,
        totalNotPaid: 0
    };
    rents.reduce((acc, rent) => {
        if (rent.totalAmount <= 0 || rent.newBalance >= 0) {
            acc.countPaid++;
        } else if (rent.payment > 0) {
            acc.countPartiallyPaid++;
        } else {
            acc.countNotPaid++;
        }
        acc.countAll++;
        acc.totalToPay += rent.totalToPay;
        acc.totalPaid += rent.payment;
        acc.totalNotPaid -= rent.newBalance;
        return acc;
    }, overview);

    return { overview, rents };
};

////////////////////////////////////////////////////////////////////////////////
// Exported functions
////////////////////////////////////////////////////////////////////////////////
const update = (req, res) => {
    const realm = req.realm;
    let paymentData = rentModel.paymentSchema.filter(req.body);
    let currentDate = moment();

    if (req.body.year && req.body.month) {
        currentDate = moment(`${req.body.month}/${req.body.year}`, 'MM/YYYY');
    }

    if (!paymentData.promo && paymentData.promo <= 0) {
        paymentData.promo = 0;
        paymentData.notepromo = null;
    }

    if (!paymentData.extracharge && paymentData.extracharge <= 0) {
        paymentData.extracharge = 0;
        paymentData.noteextracharge = null;
    }

    occupantModel.findOne(realm, paymentData._id, (errors, dbOccupant) => {
        if (errors && errors.length > 0) {
            return res.status(500).json({ errors });
        }

        const contract = {
            frequency: 'months',
            begin: dbOccupant.beginDate,
            end: dbOccupant.endDate,
            discount: dbOccupant.discount || 0,
            vatRate: dbOccupant.vatRatio,
            properties: dbOccupant.properties,
            rents: dbOccupant.rents
        };

        const settlements = {
            payments: [],
            debts: [],
            discounts: [],
            description: ''
        };
        if (paymentData) {
            if (paymentData.payments && paymentData.payments.length) {
                settlements.payments = paymentData.payments
                    .filter(({ amount }) => amount && Number(amount) > 0)
                    .map(payment => ({
                        date: payment.date || '',
                        amount: Number(payment.amount),
                        type: payment.type || '',
                        reference: payment.reference || '',
                        description: payment.description || ''
                    }));
            }

            if (paymentData.promo) {
                settlements.discounts.push({
                    origin: 'settlement',
                    description: paymentData.notepromo || '',
                    amount: paymentData.promo * (contract.vatRate ? (1 / (1 + contract.vatRate)) : 1)
                });
            }

            if (paymentData.extracharge) {
                settlements.debts.push({
                    description: paymentData.noteextracharge || '',
                    amount: paymentData.extracharge * (contract.vatRate ? (1 / (1 + contract.vatRate)) : 1)
                });
            }

            if (paymentData.description) {
                settlements.description = paymentData.description;
            }
        }

        dbOccupant.rents = Contract.payTerm(contract, `01/${paymentData.month}/${paymentData.year} 00:00`, settlements).rents;

        occupantModel.update(realm, dbOccupant, (errors) => {
            if (errors) {
                return res.status(500).json({ errors });
            }
            const rent = dbOccupant.rents.filter(rent => rent.term === Number(currentDate.format('YYYYMMDDHH')))[0];

            res.json(FD.toRentData(rent, dbOccupant));
        });
    });
};

const rentsOfOccupant = async (req, res) => {
    const realm = req.realm;
    const { id } = req.params;
    const term = Number(moment().format('YYYYMMDDHH'));

    try {
        const dbOccupants = await _findOccupants(realm, id);
        if (!dbOccupants.length) {
            return res.sendStatus(404);
        }

        const dbOccupant = dbOccupants[0];
        const rentsToReturn = dbOccupant.rents.map(currentRent => {
            const rent = FD.toRentData(currentRent);
            if (currentRent.term === term) {
                rent.active = 'active';
            }
            rent.vatRatio = dbOccupant.vatRatio;
            return rent;
        });

        res.json({
            occupant: FD.toOccupantData(dbOccupant),
            rents: rentsToReturn
        });
    } catch (errors) {
        logger.error(errors);
        res.status(500).json({ errors });
    }
};

const rentOfOccupant = async (req, res) => {
    const realm = req.realm;
    const { id, month, year } = req.params;
    const term = Number(moment(`${month}/${year}`, 'MM/YYYY').startOf('month').format('YYYYMMDDHH'));
    try {
        const dbOccupants = await _findOccupants(realm, id, term);
        if (!dbOccupants.length) {
            return res.status(404).json({ error: 'tenant not found' });
        }

        const dbOccupant = dbOccupants[0];

        if (!dbOccupant.rents.length) {
            return res.status(404).json({ error: 'rent not found' });
        }

        const rent = FD.toRentData(dbOccupant.rents[0], dbOccupant);
        if (rent.term === Number(moment().format('YYYYMMDDHH'))) {
            rent.active = 'active';
        }
        rent.vatRatio = dbOccupant.vatRatio;

        res.json(rent);
    } catch (errors) {
        logger.error(errors);
        res.status(500).json({ errors });
    }
};

const all = async (req, res) => {
    const realm = req.realm;

    let currentDate = moment().startOf('month');
    if (req.params.year && req.params.month) {
        currentDate = moment(`${req.params.month}/${req.params.year}`, 'MM/YYYY').startOf('month');
    }

    try {
        res.json(await _getRentsDataByTerm(realm, currentDate));
    } catch (errors) {
        logger.error(errors);
        res.status(500).json({ errors });
    }
};

const overview = async (req, res) => {
    try {
        const realm = req.realm;
        let currentDate = moment().startOf('month');
        if (req.params.year && req.params.month) {
            currentDate = moment(`${req.params.month}/${req.params.year}`, 'MM/YYYY').startOf('month');
        }

        const { overview } = await _getRentsDataByTerm(realm, currentDate);
        res.json(overview);
    } catch (errors) {
        logger.error(errors);
        res.status(500).json({ errors });
    }
};

module.exports = {
    update,
    rentsOfOccupant,
    rentOfOccupant,
    all,
    overview
};
