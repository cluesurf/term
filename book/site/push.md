# Push Notifications (`seed push`)

Compose and send push notifications across platforms. Define
notification channels, target specific platforms, and include
data payloads for client-side handling.

## Basic Push Notification

```tree
seed push, name alert
  seed title, text <New Message>
  seed body, text <You have a new message>
  seed channel, text <messages>
```

Send from a route handler:

```tree
dock /messages
  task post
    take body
      like hash
        link to, like text
        link text, like text

    save message
      call make-message
        bind to, read to
        bind text, read text

    call send-push
      bind name, text <alert>
      bind user-id, read to
      bind title, text <New Message>
      bind body, read text

    send json
      seed code, mark 201
      read message
```

## Platform-Specific Options

Use `case` blocks to configure per-platform behavior. Each platform
has its own notification options.

```tree
seed push, name order-update
  seed title, text <Order Update>
  seed body, text <Your order status changed>
  seed channel, text <orders>

  case ios
    seed sound, text <order.caf>
    seed badge, mark 1
    seed category, text <ORDER_UPDATE>
    seed mutable-content, wave true

  case android
    seed icon, text <ic_order>
    seed color, text <#4CAF50>
    seed priority, text <high>
    seed click-action, text <OPEN_ORDER>

  case web
    seed icon, text </icons/order.png>
    seed vibrate, mark 200
    seed require-interaction, wave true
    seed action
      link id, text <view>
      link title, text <View Order>
      link url, text </orders>
```

## Data Payload

Include structured data alongside the notification. The client app
receives this data for custom handling.

```tree
call send-push
  bind user-id, read user/id
  bind title, text <Payment Received>
  bind body
    call concat
      bind a, text <$>
      bind b
        call to-text
          bind value, read payment/amount
      bind c, text < received>
  bind channel, text <payments>
  bind data
    make push-data
      bind payment-id, read payment/id
      bind amount, read payment/amount
      bind status, text <completed>
      bind screen, text <payment-detail>
```

## Silent Push

Send a data-only notification without displaying to the user.
Useful for background data sync.

```tree
call send-push
  bind user-id, read user/id
  bind silent, wave true
  bind data
    make push-data
      bind action, text <sync>
      bind resource, text <messages>
      bind last-id, read last-message-id
```

## Notification Channels

Define channels that users can subscribe to independently. Each
channel has its own priority and behavior settings.

```tree
seed push-channel, name messages
  seed title, text <Messages>
  seed description, text <New message notifications>
  seed priority, text <high>
  seed sound, text <message.caf>

seed push-channel, name orders
  seed title, text <Order Updates>
  seed description, text <Order status changes>
  seed priority, text <high>

seed push-channel, name marketing
  seed title, text <Promotions>
  seed description, text <Deals and offers>
  seed priority, text <low>
  seed default, wave false
```

## Topic Subscriptions

Subscribe users to push topics for broadcast notifications.

```tree
dock /push/subscribe
  task post
    take head
      link authorization, like text
    take body
      like hash
        link topic, like text

    save payload
      call verify-jwt
        bind token
          call parse-bearer
            bind value, read authorization
        halt kink

    call subscribe-to-topic
      bind user-id, read payload/sub
      bind topic, read topic

    send json
      make result
        bind subscribed, wave true
        bind topic, read topic

dock /push/unsubscribe
  task post
    take head
      link authorization, like text
    take body
      like hash
        link topic, like text

    save payload
      call verify-jwt
        bind token
          call parse-bearer
            bind value, read authorization
        halt kink

    call unsubscribe-from-topic
      bind user-id, read payload/sub
      bind topic, read topic

    send json
      make result
        bind unsubscribed, wave true
```

Send to all subscribers of a topic:

```tree
task broadcast-to-topic
  take topic, like text
  take title, like text
  take body, like text
  take data, like hash
    need false

  call send-push-to-topic
    bind topic, read topic
    bind title, read title
    bind body, read body
    bind data, read data
```

## Device Registration

Register push tokens from client devices.

```tree
dock /push/register
  task post
    take head
      link authorization, like text
    take body
      like hash
        link token, like text
        link platform, like text
          mill enum
            case ios
            case android
            case web

    save payload
      call verify-jwt
        bind token
          call parse-bearer
            bind value, read authorization
        halt kink

    call save-push-token
      bind user-id, read payload/sub
      bind token, read token
      bind platform, read platform

    send json
      seed code, mark 201
      make result
        bind registered, wave true
```

## Scheduled Push

Send a notification at a future time.

```tree
call schedule-push
  bind user-id, read user/id
  bind send-at, read reminder/time
  bind title, text <Reminder>
  bind body, read reminder/text
  bind channel, text <reminders>
  bind data
    make push-data
      bind reminder-id, read reminder/id
      bind screen, text <reminder-detail>
```

## Batch Push

Send to multiple users at once.

```tree
task send-announcement
  take title, like text
  take body, like text
  take user-ids, like list

  call send-push-batch
    bind user-ids, read user-ids
    bind title, read title
    bind body, read body
    bind channel, text <announcements>
```

## Full Example

A complete push notification system with registration, channels,
topics, and multi-platform delivery.

```tree
seed push-channel, name chat
  seed title, text <Chat>
  seed description, text <New chat messages>
  seed priority, text <high>
  seed sound, text <chat.caf>

seed push-channel, name updates
  seed title, text <Updates>
  seed description, text <App and content updates>
  seed priority, text <default>

dock /push
  dock /register
    task post
      take head
        link authorization, like text
      take body
        like hash
          link token, like text
          link platform, like text
            mill enum
              case ios
              case android
              case web

      save payload
        call verify-jwt
          bind token
            call parse-bearer
              bind value, read authorization
          halt kink

      call save-push-token
        bind user-id, read payload/sub
        bind token, read token
        bind platform, read platform

      send json
        seed code, mark 201

  dock /subscribe
    task post
      take head
        link authorization, like text
      take body
        like hash
          link topics, like list

      save payload
        call verify-jwt
          bind token
            call parse-bearer
              bind value, read authorization
          halt kink

      walk list, read topics
        hook next
          take site, name topic
          call subscribe-to-topic
            bind user-id, read payload/sub
            bind topic, read topic

      send json
        make result
          bind subscribed, read topics

task send-chat-push
  take from-user, like hash
    link id, like text
    link name, like text
  take to-user-id, like text
  take message, like text

  call send-push
    bind user-id, read to-user-id
    bind title, read from-user/name
    bind body, read message
    bind channel, text <chat>
    bind data
      make push-data
        bind from-id, read from-user/id
        bind screen, text <chat>
        bind message, read message

    case ios
      seed sound, text <chat.caf>
      seed badge, mark 1
      seed category, text <CHAT_MESSAGE>
      seed mutable-content, wave true

    case android
      seed icon, text <ic_chat>
      seed color, text <#2196F3>
      seed priority, text <high>
      seed click-action, text <OPEN_CHAT>
```

## Feature Summary

| Feature | Syntax | Example |
|---|---|---|
| Push definition | `seed push, name x` | `seed push, name alert` |
| Title | `seed title` | `seed title, text <New Message>` |
| Body | `seed body` | `seed body, text <Hello>` |
| Channel | `seed channel` | `seed channel, text <messages>` |
| iOS options | `case ios` | `seed sound, text <alert.caf>` |
| Android options | `case android` | `seed priority, text <high>` |
| Web options | `case web` | `seed vibrate, mark 200` |
| Data payload | `bind data` | `make push-data` with fields |
| Silent push | `bind silent` | `bind silent, wave true` |
| Channel definition | `seed push-channel, name x` | notification categories |
| Topic subscribe | `call subscribe-to-topic` | `bind topic, read topic` |
| Topic broadcast | `call send-push-to-topic` | broadcast to subscribers |
| Device registration | `call save-push-token` | `bind platform, read platform` |
| Scheduled push | `call schedule-push` | `bind send-at, read time` |
| Batch push | `call send-push-batch` | `bind user-ids, read ids` |
| Send push | `call send-push` | `bind user-id, read id` |
