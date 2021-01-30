const axios = require("axios")
const qs = require("qs")
const commerceUrl = process.env['SAP_COMMERCE_CLOUD_COMMERCE_WEBSERVICES_79BAA5B6_4084_458E_A876_7AF9944D1E47_GATEWAY_URL']

module.exports = {
    main: async function (event, context) {
        const orderCode = event.data.orderCode
        const orderStatus = event.data.orderStatus

        console.log(`Order Number from event is: ${orderCode}`)
        console.log(`Order Status from event is: ${orderStatus}`)

        if (orderStatus === "DELAYED") {
            var orderResult = await getOrderDetails(orderCode)
            console.log("----------Result----------")
            console.log(`Business Partner for Order is: ${orderResult.bpId}`)

            try {

                const respBearerABAP = await getBearerToken4ABAP()

                const orderHistory = await getOrderHistoryABAP(respBearerABAP, orderResult.bpId)

                console.log("----------Order History----------")
                console.log(orderHistory)

                const sentimentResult = await getSentimentAnalysis(orderHistory)

                console.log("----------Sentiment Result----------")
                console.log(sentimentResult)

                const bearerTokenBRM = await getBearerToken4BRM()
                const nextAction = await executeRules(orderHistory, sentimentResult, bearerTokenBRM)

                console.log("----------Result from Business Rule Evaluation----------")
                console.log(nextAction.data.Result[0].FollowupAction)

            } catch (err) {
                console.error(err);
            }

        }
        else {
            console.log("No issues with order, nothing to do")
        }

    }
}

async function getOrderDetails(orderCode) {
    const ordersUrl = commerceUrl + "/electronics/orders/" + orderCode

    const response = await axios.get(ordersUrl)

    return response.data
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getBearerToken4ABAP() {

    let data = {
        grant_type: "client_credentials",
        scope: process.env['ABAP_MOCK_SCOPE']
    }

    let auth = {
        username: process.env['CLIENT_ID'],
        password: process.env['CLIENT_SECRET'],
    }

    let optionsToken = {
        method: "post",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data: qs.stringify(data),
        auth: auth,
        url: process.env['TOKEN_ENDPOINT_ABAP'],
    }

    const resp = await axios(optionsToken)

    return resp

}

async function getOrderHistoryABAP(tokenABAP, bpId) {

    const configOrderHistory = {
        headers: { Authorization: `${tokenABAP.data.token_type} ${tokenABAP.data.access_token}` }
    }

    axios.defaults.headers.get['Content-Type'] = 'application/json'

    const orderHistory = await axios.get(`${process.env['BASE_URL_ABAP']}/orderhistory?bpid=${bpId}`, configOrderHistory)

    return orderHistory
}

async function getSentimentAnalysis(orderHistoryInput) {

    let options = {
        method: "GET",
        data: orderHistoryInput.data,
        url: process.env['DURABLE_FUNC_ENDPOINT']

    }
    const durableStatus = await axios(options)

    if (durableStatus.status == "202") {

        let retry = true
        let result

        while (retry === true) {

            await sleep(3000)

            let responseStatus = await axios.get(durableStatus.data.statusQueryGetUri)

            if (responseStatus.data.runtimeStatus == "Completed" || responseStatus.data.runtimeStatus == "Failed") {
                retry = false
                result = responseStatus.data.output
            }
            else {
                console.log(responseStatus.data.runtimeStatus)
            }

        }

        return result

    }
    else {
        console.log("ERROR, ERROR, ERROR")
    }
}

async function getBearerToken4BRM() {

    let data = {
        grant_type: "password",
        responsetype: "token",
        username: process.env['BRM_OAUTH_USER'],
        password: process.env['BRM_OAUTH_PW']
    }

    let auth = {
        username: process.env['BRM_CLIENT_ID'],
        password: process.env['BRM_CLIENT_SECRET']
    }

    let optionsToken = {
        method: "post",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data: qs.stringify(data),
        auth: auth,
        url: process.env['BRM_OAUTH_URL']
    }

    const resp = await axios(optionsToken)

    return resp

}

async function executeRules(orderHistory, sentimentResult, bearerTokenBRM) {


    const configRuleExecution = {
        headers: { Authorization: `${bearerTokenBRM.data.token_type} ${bearerTokenBRM.data.access_token}` }
    }

    const data = {
        "RuleServiceId": process.env['RULE_SERVICE_ID'],
        "Vocabulary": [
            {
                "OrderClassification": {
                    "delayedOrdersCount": orderHistory.data.length,
                    "delayedOrdersCountNegative": sentimentResult.negativeRatingCount,
                    "delayedOrdersCountNeutral": sentimentResult.neutralRatingCount,
                    "delayedOrdersCountPositive": sentimentResult.positiveRatingCount
                }
            }
        ]

    }

    axios.defaults.headers.post['Content-Type'] = 'application/json'

    const ruleResult = await axios.post(process.env['BRM_RULEEXEC_URL'], data, configRuleExecution)

    return ruleResult

}