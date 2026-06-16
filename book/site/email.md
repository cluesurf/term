# Email (`seed email`)

Compose and send emails declaratively. Define templates with dynamic
data, set recipients and subjects, and trigger sends from route
handlers or background tasks.

## Basic Email

```tree
seed email, name welcome
  seed from, text <hello@example.com>
  seed to, read user/email
  seed subject, text <Welcome aboard>
  seed template, text <welcome>
```

## Welcome Email with Data

Pass dynamic data into a template with `seed data`. Each `link` becomes
a variable available in the template.

```tree
seed email, name welcome
  seed from, text <team@example.com>
  seed to, read user/email
  seed subject, text <Welcome to the platform>
  seed template, text <welcome>
  seed data
    link name, read user/name
    link login-url, text <https://example.com/login>
```

Send it from a route handler:

```tree
dock /auth/register
  task post
    take body
      like hash
        link name, like text
        link email, like text
          mill email
        link password, like text

    save user
      call make-user
        bind name, read name
        bind email, read email
        bind password, read password

    call send-email
      bind name, text <welcome>
      bind to, read user/email
      bind data
        make email-data
          bind name, read user/name
          bind login-url, text <https://example.com/login>

    send json
      seed code, mark 201
      read user
```

## Transactional Email

Order confirmation with multiple data fields.

```tree
seed email, name order-confirm
  seed from, text <orders@shop.com>
  seed to, read order/email
  seed subject, text <Order confirmed>
  seed template, text <order-confirm>
  seed data
    link order-id, read order/id
    link items, read order/items
    link total, read order/total
    link address, read order/shipping-address
```

Send on order creation:

```tree
dock /orders
  task post
    take body
      like hash
        link items, like list
        link address, like text
        link email, like text

    save order
      call make-order
        bind items, read items
        bind address, read address
        bind email, read email

    call send-email
      bind name, text <order-confirm>
      bind to, read email
      bind data
        make email-data
          bind order-id, read order/id
          bind items, read order/items
          bind total, read order/total
          bind address, read order/shipping-address

    send json
      seed code, mark 201
      read order
```

## Password Reset Email

```tree
seed email, name password-reset
  seed from, text <security@example.com>
  seed to, read user/email
  seed subject, text <Reset your password>
  seed template, text <password-reset>
  seed data
    link name, read user/name
    link reset-url, read reset-url
    link expire, text <1 hour>
```

## Bulk Email

Send to a list of recipients. Use `walk list` to iterate and send
individually.

```tree
task send-newsletter
  take recipients, like list
  take subject, like text
  take content, like text

  walk list, read recipients
    hook next
      take site, name user
      call send-email
        bind name, text <newsletter>
        bind to, read user/email
        bind data
          make email-data
            bind name, read user/name
            bind subject, read subject
            bind content, read content
            bind unsubscribe-url
              call make-unsubscribe-url
                bind user-id, read user/id
```

## HTML and Text Templates

Define both HTML and plain text variants. The `seed format` field
controls which version to send.

```tree
seed email, name invoice
  seed from, text <billing@example.com>
  seed to, read customer/email
  seed subject, text <Your invoice>
  seed template, text <invoice>
  seed format, text <html>
  seed data
    link invoice-id, read invoice/id
    link amount, read invoice/amount
    link due-date, read invoice/due-date
    link pdf-url, read invoice/pdf-url
```

Send plain text only:

```tree
seed email, name alert
  seed from, text <alerts@example.com>
  seed to, read admin/email
  seed subject, text <System alert>
  seed template, text <alert>
  seed format, text <text>
  seed data
    link message, read alert/message
    link timestamp, read alert/time
```

## Reply-To and CC

```tree
seed email, name support-reply
  seed from, text <support@example.com>
  seed reply-to, read agent/email
  seed to, read ticket/customer-email
  seed cc, read ticket/manager-email
  seed subject, text <Re: Your support ticket>
  seed template, text <support-reply>
  seed data
    link ticket-id, read ticket/id
    link response, read reply/body
```

## Attachments

```tree
seed email, name report
  seed from, text <reports@example.com>
  seed to, read manager/email
  seed subject, text <Monthly report>
  seed template, text <report>
  seed attach
    link name, text <report.pdf>
    link path, read report/pdf-path
    link type, text <application/pdf>
  seed data
    link month, read report/month
    link summary, read report/summary
```

## Full Example

A complete email module with multiple templates and a send helper.

```tree
seed email, name welcome
  seed from, text <team@acme.com>
  seed subject, text <Welcome to Acme>
  seed template, text <welcome>

seed email, name verify
  seed from, text <security@acme.com>
  seed subject, text <Verify your email>
  seed template, text <verify>

seed email, name reset
  seed from, text <security@acme.com>
  seed subject, text <Reset your password>
  seed template, text <reset>

dock /auth/register
  task post
    take body
      like hash
        link name, like text
        link email, like text
          mill email
        link password, like text

    save user
      call make-user
        bind name, read name
        bind email, read email
        bind password, read password

    save token
      call make-verify-token
        bind user-id, read user/id

    call send-email
      bind name, text <welcome>
      bind to, read user/email
      bind data
        make email-data
          bind name, read user/name

    call send-email
      bind name, text <verify>
      bind to, read user/email
      bind data
        make email-data
          bind verify-url
            call make-verify-url
              bind token, read token

    send json
      seed code, mark 201
      read user

dock /auth/forgot-password
  task post
    take body
      like hash
        link email, like text
          mill email

    save user
      call find-user-by-email
        bind email, read email

    fork test
      hook test
        call is-some, read user
      hook hold
        save token
          call make-reset-token
            bind user-id, read user/id
        call send-email
          bind name, text <reset>
          bind to, read user/email
          bind data
            make email-data
              bind name, read user/name
              bind reset-url
                call make-reset-url
                  bind token, read token

    send json
      make result
        bind status, text <ok>
```

## Feature Summary

| Feature | Syntax | Example |
|---|---|---|
| Email definition | `seed email, name x` | `seed email, name welcome` |
| Sender | `seed from` | `seed from, text <hello@example.com>` |
| Recipient | `seed to` | `seed to, read user/email` |
| Subject line | `seed subject` | `seed subject, text <Welcome>` |
| Template | `seed template` | `seed template, text <welcome>` |
| Dynamic data | `seed data` + `link` | `link name, read user/name` |
| Format | `seed format` | `seed format, text <html>` |
| Reply-to | `seed reply-to` | `seed reply-to, read agent/email` |
| CC | `seed cc` | `seed cc, read manager/email` |
| Attachments | `seed attach` + `link` | `link path, read report/pdf-path` |
| Send email | `call send-email` | `bind name, text <welcome>` |
| Bulk send | `walk list` + `call send-email` | iterate recipients |
